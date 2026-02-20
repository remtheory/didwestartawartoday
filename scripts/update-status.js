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

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!NEWS_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing required environment variables: NEWS_API_KEY, ANTHROPIC_API_KEY');
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

// ── Fetch headlines ──────────────────────────────────────────────────────────

async function fetchHeadlines() {
  const query = 'US military OR airstrike OR troops OR invasion OR escalation OR Pentagon OR weapons transfer';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fromDate = yesterday.toISOString().split('T')[0];

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', query);
  url.searchParams.set('from', fromDate);
  url.searchParams.set('sortBy', 'relevancy');
  url.searchParams.set('language', 'en');
  url.searchParams.set('pageSize', '20');
  url.searchParams.set('apiKey', NEWS_API_KEY);

  console.log(`Fetching headlines from NewsAPI (from ${fromDate})...`);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NewsAPI error ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (!data.articles || data.articles.length === 0) {
    throw new Error('No articles returned from NewsAPI');
  }

  console.log(`Got ${data.articles.length} articles.`);

  // Return simplified headline objects
  return data.articles
    .filter(a => a.title && a.url && a.source?.name)
    .slice(0, 15)
    .map(a => ({
      title: a.title.replace(/ - [^-]+$/, '').trim(), // strip source suffix
      url: a.url,
      source: a.source.name,
      description: a.description || '',
    }));
}

// ── Claude analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(headlines) {
  const headlineText = headlines
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title}${h.description ? '\n   ' + h.description : ''}`)
    .join('\n\n');

  const prompt = `You are assessing whether the United States initiated or significantly escalated armed conflict today.

"Armed conflict" includes: airstrikes, military invasions, significant troop deployments into active conflict zones, or weapons transfers that directly enable active combat operations.

It does NOT include: ongoing existing operations with no new escalation, sanctions, diplomatic threats, military posturing without action, or routine military activities.

Here are today's top news headlines:

${headlineText}

Respond ONLY with valid JSON in this exact format, with no additional text before or after:
{
  "status": "no" | "unclear" | "yes",
  "tagline": "One wry sentence, max 12 words.",
  "headlines": [
    { "title": "...", "url": "...", "source": "..." },
    { "title": "...", "url": "...", "source": "..." }
  ]
}

Choose 2-3 of the most relevant headlines from the provided list for the headlines array. If status is "no", pick the most relevant peaceful/routine headlines. The tagline should be darkly wry and specific to today's situation.`;

  console.log('Sending to Claude for analysis...');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
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
  if (!['no', 'unclear', 'yes'].includes(parsed.status)) {
    throw new Error(`Invalid status from Claude: ${parsed.status}`);
  }
  if (!parsed.tagline || typeof parsed.tagline !== 'string') {
    throw new Error('Missing or invalid tagline from Claude');
  }
  if (!Array.isArray(parsed.headlines) || parsed.headlines.length === 0) {
    throw new Error('Missing or empty headlines from Claude');
  }

  return parsed;
}

// ── Write status.json ────────────────────────────────────────────────────────

function writeStatus(result) {
  const output = {
    status: result.status,
    tagline: result.tagline,
    updated: new Date().toISOString(),
    headlines: result.headlines.map(h => ({
      title: h.title,
      url: h.url,
      source: h.source,
    })),
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
    const headlines = await fetchHeadlines();
    const result = await analyzeWithClaude(headlines);
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
