import { fetchWebsiteText, validatePublicWebsiteUrl } from './webSource.js';

const MAX_PAGES = 5;
const MAX_TOTAL_READABLE_CHARS = 40_000;
const MAX_CANDIDATES = 40;
const MAX_CRAWL_ATTEMPTS = 12;
const BLOCKED_ROUTE = /(^|\/)(?:auth|login|log-in|signin|sign-in|signup|sign-up|account|accounts|cart|basket|checkout|admin|wp-admin|privacy|privacy-policy|terms|terms-of-service|legal)(?:\/|$)/i;
const BINARY_EXTENSION = /\.(?:7z|avi|avif|bmp|csv|docx?|exe|gif|gz|ico|jpe?g|json|m4a|mov|mp3|mp4|mpeg|pdf|png|pptx?|rar|rss|svg|tar|tiff?|webm|webp|xlsx?|xml|zip)$/i;
const USEFUL_PATHS = ['product', 'service', 'shop', 'about', 'pricing', 'collection', 'blog'];

function boundedInteger(value, fallback, ceiling) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, ceiling) : fallback;
}

function normalizeCandidate(rawUrl, baseUrl, rootOrigin) {
  let url;
  try {
    url = new URL(String(rawUrl || ''), baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.origin !== rootOrigin) return null;
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (BLOCKED_ROUTE.test(decodedPath) || BINARY_EXTENSION.test(decodedPath)) return null;
  return url;
}

function rankCandidate(url) {
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  const pathText = segments.join('/');
  const usefulIndex = USEFUL_PATHS.findIndex((term) => pathText.split('/').some((segment) => segment === term || segment.startsWith(`${term}-`) || segment.startsWith(`${term}s`)));
  return [usefulIndex === -1 ? 1 : 0, segments.length, usefulIndex === -1 ? USEFUL_PATHS.length : usefulIndex, url.pathname.toLowerCase()];
}

function compareCandidates(left, right) {
  const a = rankCandidate(left);
  const b = rankCandidate(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return left.toString().localeCompare(right.toString());
}

function readablePage(page, url, sourceReference, remainingChars) {
  const text = String(page?.text || '').trim().slice(0, remainingChars);
  if (!text) return null;
  return {
    sourceReference,
    url: url.toString(),
    title: String(page?.title || '').trim().slice(0, 1000),
    description: String(page?.description || '').trim().slice(0, 2000),
    canonicalUrl: String(page?.canonicalUrl || '').trim().slice(0, 2000),
    h1: String(page?.h1 || '').trim().slice(0, 1000),
    text,
  };
}

export async function fetchWebsiteIntelligence(rawUrl, options = {}) {
  const fetchPage = options.fetchPage || fetchWebsiteText;
  const validateUrl = options.validateUrl || validatePublicWebsiteUrl;
  const maxPages = boundedInteger(options.maxPages, MAX_PAGES, MAX_PAGES);
  const maxTotalChars = boundedInteger(options.maxTotalChars, MAX_TOTAL_READABLE_CHARS, MAX_TOTAL_READABLE_CHARS);

  const requestedRoot = await validateUrl(rawUrl);
  const rootResult = await fetchPage(requestedRoot.toString());
  const rootFinalUrl = await validateUrl(rootResult?.url || requestedRoot.toString());
  const rootOrigin = rootFinalUrl.origin;
  const rootPage = readablePage(rootResult, rootFinalUrl, 'website_home', maxTotalChars);
  if (!rootPage) throw Object.assign(new Error('Dovroyn could not find readable text on that page.'), { status: 422 });

  const pages = [rootPage];
  let totalReadableChars = rootPage.text.length;
  const returnedUrls = new Set();
  const consideredUrls = new Set();
  const candidates = new Map();

  const rootKey = normalizeCandidate(rootFinalUrl, rootFinalUrl, rootOrigin)?.toString() || rootFinalUrl.toString();
  returnedUrls.add(rootKey);
  consideredUrls.add(rootKey);

  const enqueue = (links, baseUrl) => {
    for (const link of Array.isArray(links) ? links : []) {
      const candidate = normalizeCandidate(link, baseUrl, rootOrigin);
      if (!candidate) continue;
      const key = candidate.toString();
      if (!consideredUrls.has(key) && !candidates.has(key)) candidates.set(key, candidate);
    }
    if (candidates.size > MAX_CANDIDATES) {
      const bestCandidates = [...candidates.values()].sort(compareCandidates).slice(0, MAX_CANDIDATES);
      candidates.clear();
      bestCandidates.forEach((candidate) => candidates.set(candidate.toString(), candidate));
    }
  };
  enqueue(rootResult?.links, rootFinalUrl);

  let crawlAttempts = 0;
  while (pages.length < maxPages && totalReadableChars < maxTotalChars && candidates.size && crawlAttempts < MAX_CRAWL_ATTEMPTS) {
    const candidate = [...candidates.values()].sort(compareCandidates)[0];
    const candidateKey = candidate.toString();
    candidates.delete(candidateKey);
    consideredUrls.add(candidateKey);
    crawlAttempts += 1;
    try {
      const validatedCandidate = await validateUrl(candidateKey);
      if (validatedCandidate.origin !== rootOrigin) continue;
      const result = await fetchPage(validatedCandidate.toString());
      const finalUrl = await validateUrl(result?.url || validatedCandidate.toString());
      const normalizedFinal = normalizeCandidate(finalUrl, finalUrl, rootOrigin);
      if (!normalizedFinal || returnedUrls.has(normalizedFinal.toString())) continue;
      const page = readablePage(result, finalUrl, `website_page_${pages.length + 1}`, maxTotalChars - totalReadableChars);
      if (!page) continue;
      pages.push(page);
      returnedUrls.add(normalizedFinal.toString());
      totalReadableChars += page.text.length;
      enqueue(result?.links, finalUrl);
    } catch {
      // Root failures abort above; unreadable or privately resolved child pages are omitted.
    }
  }

  return { rootUrl: rootFinalUrl.toString(), pages, totalReadableChars };
}
