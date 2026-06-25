/**
 * ForkMind example — a multi-turn conversation captured into the local tree,
 * using a FREE, open-source model via Ollama. No API key, no signup.
 *
 * Prereqs:
 *   1. Install Ollama:  https://ollama.com  then  `ollama pull llama3`
 *   2. Install the OpenAI SDK here:  npm i openai
 *   3. Start the proxy:  npx forkmind start   (or: npm start)
 *   4. Run this:         node examples/chain.js
 *   5. Open the dashboard at http://localhost:4500 and watch the tree grow.
 *
 * The `upstream` option tells the proxy to forward to your local Ollama server
 * instead of any paid provider. Swap it for Groq / OpenRouter / Together (all
 * OpenAI-compatible, free tiers) by changing `upstream` + `apiKey`.
 */
const { ForkMindOpenAI } = require('forkmind');

const client = new ForkMindOpenAI({
  apiKey: 'ollama', // Ollama ignores the key, but the SDK requires a value
  upstream: process.env.FORKMIND_UPSTREAM || 'http://localhost:11434',
});

async function main() {
  // Turn 1 — root node.
  const first = await client.chat.completions.create({
    model: 'llama3',
    messages: [{ role: 'user', content: 'Name one interesting fact about octopuses.' }],
  });
  console.log('Assistant:', first.choices[0].message.content);

  // Turn 2 — auto-chained as a child of turn 1 (the wrapper tracked the parent
  // id from the previous response header). No manual wiring needed.
  const second = await client.chat.completions.create({
    model: 'llama3',
    messages: [
      { role: 'user', content: 'Name one interesting fact about octopuses.' },
      first.choices[0].message,
      { role: 'user', content: 'Now explain it like I am five.' },
    ],
  });
  console.log('Assistant:', second.choices[0].message.content);

  console.log('\n✓ Captured. Open http://localhost:4500 to view the branch tree.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  console.error('Is the proxy running (npx forkmind start) and Ollama up?');
  process.exit(1);
});
