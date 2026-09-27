async function readApiResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // A 200 with a non-JSON body (e.g. a proxy error page) must not render as an empty bubble.
    const text = (await response.text().catch(() => '')).trim();
    const detail = text && text.length <= 200 && !text.includes('<') ? text : '';
    throw new Error(detail || `AI request failed (${response.status}).`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'AI request failed.');
  return payload;
}

export async function askLandingAssistant(question) {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const payload = await readApiResponse(response);
  return payload.answer;
}

export async function askDemoPodAssistant(question) {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, demoPod: true }),
  });
  const payload = await readApiResponse(response);
  return payload.answer;
}

export async function requestPodAnalysis({ accessToken, podId, sourceUrl, notes, imageUrls = [] }) {
  const response = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ podId, sourceUrl, notes, imageUrls }),
  });
  const payload = await readApiResponse(response);
  return payload;
}

export async function askPodAssistant({ accessToken, podId, question }) {
  const response = await fetch('/api/ai/pod-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ podId, question }),
  });
  return readApiResponse(response);
}

export async function requestSocialContent({ accessToken, podId, platforms, contentDay, direction = '' }) {
  const response = await fetch('/api/ai/content', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ podId, platforms, contentDay, direction }),
  });
  const payload = await readApiResponse(response);
  return payload;
}
