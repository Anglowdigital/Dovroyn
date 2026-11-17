import Ajv from 'ajv';
import { fetchWebsiteImageBytes } from './webSource.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES = 5;

function failure(code, status = 503) {
  return Object.assign(new Error('The AI service could not complete this request.'), {
    provider: 'bedrock', code, status,
  });
}

export function resolveBedrockConfig(workload, env = process.env) {
  const region = String(env.AWS_REGION || '').trim();
  const roleArn = String(env.AWS_ROLE_ARN || '').trim();
  const modelId = String(env[`BEDROCK_${workload}_MODEL`] || env.BEDROCK_MODEL_ID || '').trim();
  const maxTokens = Number(env.BEDROCK_MAX_OUTPUT_TOKENS || 8192);
  // No default model or region: the operator must choose an enabled model and
  // its data-processing region. Vercel exchanges OIDC for temporary AWS access.
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
      || !/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn)
      || !modelId || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
    throw failure('missing_configuration');
  }
  return { region, roleArn, modelId, maxTokens };
}

async function imageBlock(source) {
  let bytes;
  if (typeof source !== 'string') throw failure('invalid_image');
  if (source.startsWith('data:')) {
    if (source.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64) throw failure('invalid_image');
    const match = source.match(/^data:image\/(?:jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw failure('invalid_image');
    bytes = Buffer.from(match[1], 'base64');
  } else {
    // Reuse DNS pinning, public-address validation, timeouts, raster MIME checks,
    // byte limits and redirect refusal. Do not fetch arbitrary URLs with fetch().
    if (!/^https:\/\//i.test(source)) throw failure('invalid_image');
    bytes = await fetchWebsiteImageBytes(source, source);
  }
  if (!bytes?.length || bytes.length > MAX_IMAGE_BYTES) throw failure('invalid_image');
  const { default: sharp } = await import('sharp');
  const image = sharp(bytes, { limitInputPixels: 16_000_000 });
  const { format, pages } = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'gif', 'heif'].includes(format) || pages > 1) throw failure('invalid_image');
  const jpeg = await image.rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
  return { image: { format: 'jpeg', source: { bytes: jpeg } } };
}

export async function buildBedrockRequest(body, config) {
  // OpenAI's built-in web search has no equivalent in this adapter. Never drop
  // requested tools and let a model imply that fresh research happened.
  if (body.tools?.length) throw failure('unsupported_tools');
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || !input.length) throw failure('invalid_input');
  const messages = [];
  let images = 0;
  for (const message of input) {
    if (!['user', 'assistant'].includes(message.role)) throw failure('invalid_input');
    const parts = typeof message.content === 'string'
      ? [{ type: 'input_text', text: message.content }] : message.content;
    if (!Array.isArray(parts) || !parts.length) throw failure('invalid_input');
    const content = [];
    for (const part of parts) {
      if (['input_text', 'output_text'].includes(part.type) && typeof part.text === 'string' && part.text.trim()) {
        content.push({ text: part.text });
      } else if (part.type === 'input_image' && message.role === 'user' && ++images <= MAX_IMAGES) {
        try { content.push(await imageBlock(part.image_url)); }
        catch { throw failure('invalid_image'); }
      } else {
        throw failure('invalid_input');
      }
    }
    // Stored pod context can precede a user turn. Merge adjacent same-role
    // messages for models that require alternation, preserving their order.
    if (messages.at(-1)?.role === message.role) messages.at(-1).content.push(...content);
    else messages.push({ role: message.role, content });
  }
  const request = {
    modelId: config.modelId,
    messages,
    ...(body.instructions ? { system: [{ text: body.instructions }] } : {}),
    inferenceConfig: { maxTokens: Math.min(body.max_output_tokens || config.maxTokens, config.maxTokens) },
  };
  const format = body.text?.format;
  if (format) {
    if (format.type !== 'json_schema' || !/^[a-zA-Z0-9_-]{1,64}$/.test(format.name || '')) throw failure('invalid_schema');
    // This is a response envelope, never an executable tool. Validate the
    // returned object locally before any route can save analysis or content.
    request.toolConfig = {
      tools: [{ toolSpec: { name: format.name, description: 'Return the requested structured result.', inputSchema: { json: format.schema } } }],
      toolChoice: { tool: { name: format.name } },
    };
  }
  return request;
}

export function normalizeBedrockResponse(result, format) {
  const message = result?.output?.message;
  if (message?.role !== 'assistant' || !Array.isArray(message.content) || !message.content.length) throw failure('invalid_output');
  let text;
  if (format) {
    const block = message.content[0];
    if (result.stopReason !== 'tool_use' || message.content.length !== 1 || !block.toolUse
        || block.toolUse.name !== format.name) throw failure('invalid_output');
    const validate = new Ajv({ strict: true, allErrors: false }).compile(format.schema);
    if (!validate(block.toolUse.input)) throw failure('invalid_output');
    text = JSON.stringify(block.toolUse.input);
  } else {
    // Never accept truncated output, guardrail interventions or tool requests as
    // an answer, and never retry them through another model.
    if (result.stopReason !== 'end_turn' || message.content.some((block) => typeof block.text !== 'string')) throw failure('invalid_output');
    text = message.content.map((block) => block.text).join('');
    if (!text.trim()) throw failure('invalid_output');
  }
  return { status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }] };
}

export async function createBedrockResponse(body, { workload, env = process.env, sendConverse } = {}) {
  const config = resolveBedrockConfig(workload, env);
  const request = await buildBedrockRequest(body, config);
  let client;
  try {
    if (!sendConverse) {
      const [{ BedrockRuntimeClient, ConverseCommand }, { awsCredentialsProvider }] = await Promise.all([
        import('@aws-sdk/client-bedrock-runtime'), import('@vercel/oidc-aws-credentials-provider'),
      ]);
      client = new BedrockRuntimeClient({
        region: config.region, maxAttempts: 1,
        credentials: awsCredentialsProvider({ roleArn: config.roleArn, clientConfig: { region: config.region, maxAttempts: 1 } }),
      });
      sendConverse = (input) => client.send(new ConverseCommand(input), { abortSignal: AbortSignal.timeout(45_000) });
    }
    const result = await sendConverse(request);
    return normalizeBedrockResponse(result, body.text?.format);
  } catch (error) {
    if (error?.provider === 'bedrock') throw error;
    const codes = new Set(['ThrottlingException', 'ServiceQuotaExceededException', 'ServiceUnavailableException', 'InternalServerException', 'ModelTimeoutException', 'AccessDeniedException', 'ValidationException', 'ExpiredTokenException', 'AbortError', 'TimeoutError']);
    const code = codes.has(error?.name) ? error.name : 'bedrock_request_failed';
    // Do not return or log AWS messages, request bodies, account IDs or tokens.
    console.error('dovroyn_bedrock_failure', { code });
    throw failure(code, code === 'ThrottlingException' ? 429 : 503);
  } finally {
    client?.destroy();
  }
}
