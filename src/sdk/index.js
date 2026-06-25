// Public SDK surface.
//
// The provider wrappers extend optional peer SDKs (openai, @anthropic-ai/sdk).
// We expose them as lazy getters so simply `require('forkmind')` never throws
// when a provider package isn't installed — the error only surfaces if you
// actually construct that wrapper.
const { createForkMindOpenAI } = require('./openai');
const { createForkMindAnthropic } = require('./anthropic');

let _openai;
let _anthropic;

module.exports = {
  get ForkMindOpenAI() {
    if (!_openai) _openai = createForkMindOpenAI();
    return _openai;
  },
  get ForkMindAnthropic() {
    if (!_anthropic) _anthropic = createForkMindAnthropic();
    return _anthropic;
  },
};
