#!/usr/bin/env node
/**
 * update-status.js
 * Daily pipeline: fetch headlines → Claude analysis → write status.json
 *
 * Required env vars:
 *   NEWS_API_KEY       — newsapi.org API key
 *   ANTHROPIC_API_KEY  — Anthropic API key
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(__dirname, '..', 'status.json');

// ── Config ──────────────────────────────────────────────────────────────────

const PERIGON_API_KEY = process.env.PERIGON_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!PERIGON_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing required environment variables: PERIGON_API_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}

const SEARCH_KEYWORDS = [
  'US military strike',
  'United States airstrike',
  'US troops deployment',
  'US military invasion',
  'American military operation',
  'US escalation military',
  'Pentagon military action',
  'US armed conflict',
];

const CLAUDE_MODEL = 'claude-sonnet-4-6';

// Sources excluded for being state media, unreliable, or highly biased
const EXCLUDED_DOMAINS = [
  'rt.com',           // Russian state media
  'sputniknews.com',  // Russian state media
  'tass.com',         // Russian state media
  'xinhuanet.com',    // Chinese state media
  'globaltimes.cn',   // Chinese state media
  'presstv.ir',       // Iranian state media
  'breitbart.com',
  'infowars.com',
];

// ── Fetch headlines ──────────────────────────────────────────────────────────

async function fetchHeadlines() {
  const query = 'US military OR airstrike OR troops OR invasion OR escalation OR Pentagon OR weapons transfer';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fromDate = yesterday.toISOString().split('T')[0];

  const url = new URL('https://api.goperigon.com/v1/all');
  url.searchParams.set('q', query);
  url.searchParams.set('from', fromDate);
  url.searchParams.set('sortBy', 'date');
  url.searchParams.set('language', 'en');
  url.searchParams.set('size', '20');
  url.searchParams.set('paywall', 'false');
  url.searchParams.set('apiKey', PERIGON_API_KEY);

  console.log(`Fetching headlines from Perigon (from ${fromDate})...`);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perigon API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (!data.articles || data.articles.length === 0) {
    throw new Error('No articles returned from Perigon');
  }

  console.log(`Got ${data.articles.length} articles.`);

  // Return simplified headline objects, excluding untrusted sources
  return data.articles
    .filter(a => a.title && a.url)
    .filter(a => !EXCLUDED_DOMAINS.some(domain => a.url.includes(domain)))
    .slice(0, 15)
    .map(a => ({
      title: a.title.trim(),
      url: a.url,
      source: a.source?.domain || a.source?.name || 'Unknown',
      description: a.description || '',
    }));
}

// ── Claude analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(headlines, existingStatus) {
  // Give Claude index numbers only — URLs stay on our side to prevent hallucination
  const headlineText = headlines
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title}${h.description ? '\n   ' + h.description : ''}`)
    .join('\n\n');

  // If there's an active conflict, tell Claude about it so it can use "ongoing" correctly
  const conflictContext = existingStatus.activeConflict && existingStatus.conflictName
    ? `IMPORTANT CONTEXT: The US is currently in an active conflict (${existingStatus.conflictName}, started ${existingStatus.conflictStartDate}). If today's news shows continued fighting from this existing conflict with no major new escalation, use "ongoing". Only use "yes" if there is a genuinely NEW military action or a major escalation beyond what is already happening.\n\n`
    : '';

  const prompt = `You are assessing whether the United States initiated or significantly escalated armed conflict today.

Use these statuses:
- "yes": The US started a NEW war or made a major NEW escalation today (e.g. first strikes, invading a new country).
- "ongoing": The US is already in an active war and today's news is continued fighting — not a new initiation or major escalation.
- "unclear": Hard to tell whether something new happened.
- "no": No armed conflict today.

"Armed conflict" includes: airstrikes, military invasions, significant troop deployments into active conflict zones, or weapons transfers that directly enable active combat operations.

It does NOT include: sanctions, diplomatic threats, military posturing without action, or routine military activities.

${conflictContext}Here are today's top news headlines (each has a number):

${headlineText}

Respond ONLY with valid JSON in this exact format, with no additional text before or after:
{
  "status": "no" | "unclear" | "ongoing" | "yes",
  "tagline": "One wry sentence, max 12 words.",
  "headline_indices": [1, 2]
}

For headline_indices, pick 2-3 numbers from the list above that are most relevant to your determination. Do NOT include any URLs or titles in your response — only the index numbers. The tagline should be darkly wry and specific to today's situation.`;

  console.log('Sending to Claude for analysis...');

  // Retry up to 3 times with exponential backoff for transient errors (e.g. 529 overloaded)
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (res.ok) break;

    const body = await res.text();
    const retryable = res.status === 529 || res.status === 503 || res.status === 500;
    if (!retryable || attempt === 3) {
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const waitMs = attempt * 10000; // 10s, then 20s
    console.log(`Attempt ${attempt} failed (${res.status}), retrying in ${waitMs / 1000}s...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text?.trim();

  if (!rawText) {
    throw new Error('Empty response from Claude');
  }

  console.log('Claude response:', rawText);

  // Parse JSON — strip any markdown code fences if Claude adds them
  const jsonText = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${rawText}`);
  }

  // Validate structure
  if (!['no', 'unclear', 'ongoing', 'yes'].includes(parsed.status)) {
    throw new Error(`Invalid status from Claude: ${parsed.status}`);
  }
  if (!parsed.tagline || typeof parsed.tagline !== 'string') {
    throw new Error('Missing or invalid tagline from Claude');
  }
  if (!Array.isArray(parsed.headline_indices) || parsed.headline_indices.length === 0) {
    throw new Error('Missing or empty headline_indices from Claude');
  }

  // Resolve indices back to real headline objects (with real URLs from NewsAPI)
  const chosenHeadlines = parsed.headline_indices
    .map(i => headlines[i - 1])  // indices are 1-based
    .filter(Boolean);

  if (chosenHeadlines.length === 0) {
    throw new Error('Claude returned invalid headline indices');
  }

  return {
    status: parsed.status,
    tagline: parsed.tagline,
    headlines: chosenHeadlines,
    allHeadlines: headlines, // full set for sidebar war coverage
  };
}

// ── Write status.json ────────────────────────────────────────────────────────

function writeStatus(result) {
  // Preserve manually-set conflict fields across daily runs
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) {}

  const output = {
    status: result.status,
    tagline: result.tagline,
    updated: new Date().toISOString(),
    headlines: result.headlines.map(h => ({
      title: h.title,
      url: h.url,
      source: h.source,
    })),
    allHeadlines: result.allHeadlines.map(h => ({
      title: h.title,
      url: h.url,
      source: h.source,
    })),
    ...(existing.activeConflict !== undefined && { activeConflict: existing.activeConflict }),
    ...(existing.conflictName      && { conflictName:      existing.conflictName }),
    ...(existing.conflictStartDate && { conflictStartDate: existing.conflictStartDate }),
    ...(existing.casualtiesUrl     && { casualtiesUrl:     existing.casualtiesUrl }),
    ...(existing.casualtiesLabel   && { casualtiesLabel:   existing.casualtiesLabel }),
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote status.json: status=${output.status}`);
  console.log(`Tagline: "${output.tagline}"`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Daily War Status Update ===');
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    let existingStatus = {};
    try { existingStatus = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (e) {}

    if (existingStatus.statusLock) {
      console.log(`statusLock is set — keeping status "${existingStatus.status}", skipping analysis.`);
      // Update the timestamp so the site shows a fresh "updated" time
      existingStatus.updated = new Date().toISOString();
      fs.writeFileSync(STATUS_FILE, JSON.stringify(existingStatus, null, 2) + '\n', 'utf8');
      console.log('Done.');
      return;
    }

    const headlines = await fetchHeadlines();
    const result = await analyzeWithClaude(headlines, existingStatus);
    writeStatus(result);
    console.log('Done.');
  } catch (err) {
    console.error('Fatal error:', err.message);

    // Write a fallback "unclear" status rather than leaving stale data
    const fallback = {
      status: 'unclear',
      tagline: "Something went wrong with today's analysis. Check back soon.",
      updated: new Date().toISOString(),
      headlines: [],
    };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(fallback, null, 2) + '\n', 'utf8');
    console.log('Wrote fallback status.json due to error.');

    process.exit(1);
  }
}

main();
