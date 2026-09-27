import { useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { askLandingAssistant } from '../lib/aiClient';

const ASSISTANT_QA = [
  {
    question: 'I run a skincare brand — what platforms should I focus on?',
    answer:
      'For skincare, run a 4-channel mix: Instagram for visual proof and social trust, TikTok for discovery + education, Pinterest for evergreen search traffic, and email for retention + repeat purchase. Audience fit: skincare buyers research before they buy, so show routines, ingredient benefits, and before/after proof. Next action: pick 3 content pillars (results, routine education, founder authority) and map one platform-first series per channel. A Dovroyn pod can build your platform plan, content pillars, hooks, calendar, and ad angles directly from your website.',
  },
  {
    question: 'Give me 3 Instagram caption ideas for a café',
    answer:
      'Three caption angles for a café: 1) Morning ritual: "Your 8:07 reset starts here — flat white, warm croissant, zero chaos." 2) Product spotlight: "Today’s hero: honey cinnamon latte + flaky almond pastry. Available until sold out." 3) Community moment: "Laptop down, first sip up. Tag your coffee person for tomorrow’s table." Audience fit: commuters and local regulars want comfort + routine. Next action: pair each caption with one clear CTA (save, tag, or visit today). A Dovroyn pod would turn this into a weekly caption bank by daypart, offer, and audience segment.',
  },
  {
    question: 'What makes a good TikTok hook?',
    answer:
      'A good TikTok hook wins the first 1-2 seconds with a specific outcome, audience callout, or tension. Use formulas like: "If you’re [audience], stop scrolling," "I wasted $X before learning this," or "Do this before you buy [category]." Platform fit: TikTok rewards clear payoff + fast pattern interrupt, then retention through quick proof. Next action: test 5 hooks on one topic, keep the winner by watch time, and reuse that structure across new videos. A Dovroyn pod can generate hook banks, script openers, and test plans matched to your niche.',
  },
  {
    question: 'How do I grow on LinkedIn as a consultant?',
    answer:
      'Grow on LinkedIn by positioning around one clear buyer and one clear outcome. Audience fit: decision-makers buy consultants who teach clearly and repeatedly. Platform fit: LinkedIn favors POV-led expertise + conversations in comments. Content angle: post 3 times weekly using this mix — one contrarian insight, one mini case breakdown, one practical framework. Next action: optimize your headline to "I help [buyer] achieve [result]," then comment on 10 ideal-client posts daily with useful, specific takes. A Dovroyn pod can build your authority content pillars, post cadence, hook library, and conversion CTAs.',
  },
];

const INTRO_MESSAGE = {
  id: 'intro',
  sender: 'assistant',
  text: 'Hey! I’m Dovroyn — your AI marketing pod assistant. Tell me about your brand or ask me anything about campaign strategy, and I’ll show you what a pod can do.',
};

const TYPED_RESPONSE =
  'Great question. Here is the high-confidence play: define your core audience first, choose one primary platform for distribution and one secondary platform for amplification, publish a single repeatable content angle for 2 weeks, then scale what earns saves, watch time, or replies. Next action: share your website and offer so a Dovroyn pod can produce your platform plan, content pillars, hooks, calendar, and ad angles.';

const TYPED_MATCHERS = [
  {
    pattern: /(skincare|skin care).*(platform|channel)|platform.*(skincare|skin care)/i,
    answer: ASSISTANT_QA[0].answer,
  },
  {
    pattern: /instagram.*caption.*(cafe|coffee)|\bcafe\b.*instagram.*caption/i,
    answer: ASSISTANT_QA[1].answer,
  },
  {
    pattern: /(tiktok|tik tok).*(hook|open|opener)|hook.*(tiktok|tik tok)/i,
    answer: ASSISTANT_QA[2].answer,
  },
  {
    pattern: /linkedin.*(consultant|consulting)|grow.*linkedin/i,
    answer: ASSISTANT_QA[3].answer,
  },
];

function resolvePreviewAnswer(question) {
  const matched = TYPED_MATCHERS.find(({ pattern }) => pattern.test(question));
  return matched ? matched.answer : TYPED_RESPONSE;
}

export default function AiPodAssistant() {
  const [messages, setMessages] = useState([INTRO_MESSAGE]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(null);
  const queuePreviewReply = async (question, activeKey = null) => {
    const cleanQuestion = question.trim();
    if (!cleanQuestion || thinking) return;

    setActiveQuestion(activeKey);
    setMessages((currentMessages) => [
      ...currentMessages,
      { id: `user-${Date.now()}`, sender: 'user', text: cleanQuestion },
    ]);
    setThinking(true);
    let answer;
    try {
      answer = await askLandingAssistant(cleanQuestion);
    } catch (error) {
      // The API returns specific { error } payloads (e.g. rate limits) — show them when present.
      answer = error?.message || 'The live assistant is temporarily unavailable. Dovroyn can still show the pod demo while the server API is being configured.';
    }
    setMessages((currentMessages) => [
      ...currentMessages,
      { id: `assistant-${Date.now()}`, sender: 'assistant', text: answer },
    ]);
    setThinking(false);
  };

  const handleSuggestedAsk = (qa, index) => {
    // For suggested questions, use the pre-written answer directly
    // This ensures the chat works even if the API is down
    const cleanQuestion = qa.question.trim();
    if (!cleanQuestion || thinking) return;

    setActiveQuestion(index);
    setMessages((currentMessages) => [
      ...currentMessages,
      { id: `user-${Date.now()}`, sender: 'user', text: cleanQuestion },
    ]);
    setThinking(true);
    
    // Simulate typing delay for natural feel
    setTimeout(() => {
      setMessages((currentMessages) => [
        ...currentMessages,
        { id: `assistant-${Date.now()}`, sender: 'assistant', text: qa.answer },
      ]);
      setThinking(false);
    }, 400 + Math.random() * 500);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    setDraft('');

    // Check if it matches a suggested question exactly
    const exactMatch = ASSISTANT_QA.find((qa) => qa.question.toLowerCase().trim() === question.toLowerCase().trim());
    if (exactMatch) {
      handleSuggestedAsk(exactMatch, null);
      return;
    }

    // Check for pattern match
    const patternMatch = TYPED_MATCHERS.find(({ pattern }) => pattern.test(question));
    if (patternMatch) {
      setMessages((currentMessages) => [
        ...currentMessages,
        { id: `user-${Date.now()}`, sender: 'user', text: question },
      ]);
      setThinking(true);
      setTimeout(() => {
        setMessages((currentMessages) => [
          ...currentMessages,
          { id: `assistant-${Date.now()}`, sender: 'assistant', text: patternMatch.answer },
        ]);
        setThinking(false);
      }, 400 + Math.random() * 500);
      return;
    }

    // Otherwise try the API
    queuePreviewReply(question, null);
  };

  return (
    <section className="ai-assistant-section">
      <p className="eyebrow">AI Assistant Preview</p>
      <h2 className="section-title">Chat with your AI marketing pod.</h2>
      <p className="lede ai-assistant-lede">
        Ask a real marketing or Dovroyn product question. Answers come from the live server-side assistant when the API is configured.
      </p>

      <div className="panel ai-assistant-card" aria-label="Interactive Dovroyn chat preview">
        <div className="ai-assistant-header">
          <span className="ai-assistant-orb" aria-hidden="true">
            <span className="ai-assistant-orb-ring" />
            <Sparkles size={16} strokeWidth={1.75} />
          </span>
          <div>
            <p className="ai-assistant-name">Dovroyn</p>
            <p className="ai-assistant-subtitle">AI Marketing Pod · Preview</p>
            <p className="ai-assistant-status"><span aria-hidden="true" />Online</p>
          </div>
        </div>

        <div className="ai-assistant-chat" aria-live="polite">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`ai-assistant-message-row ai-assistant-message-row-${message.sender}`}
            >
              {message.sender === 'assistant' && (
                <span className="ai-assistant-mini-avatar" aria-hidden="true">
                  <Sparkles size={12} strokeWidth={1.8} />
                </span>
              )}
              <p className={`ai-assistant-bubble ai-assistant-bubble-${message.sender}`}>
                {message.text}
              </p>
            </div>
          ))}
          {thinking && (
            <div className="ai-assistant-message-row ai-assistant-message-row-assistant">
              <span className="ai-assistant-mini-avatar" aria-hidden="true">
                <Sparkles size={12} strokeWidth={1.8} />
              </span>
              <div className="ai-assistant-bubble ai-assistant-bubble-assistant ai-assistant-thinking" role="status">
                <span className="ai-assistant-dot" />
                <span className="ai-assistant-dot" />
                <span className="ai-assistant-dot" />
                <span className="ai-assistant-thinking-label">Dovroyn is typing...</span>
              </div>
            </div>
          )}
        </div>

        <div className="ai-assistant-questions" role="group" aria-label="Suggested questions">
          {ASSISTANT_QA.map((qa, index) => (
            <button
              key={qa.question}
              type="button"
              className={`ai-assistant-question${activeQuestion === index ? ' active' : ''}`}
              onClick={() => handleSuggestedAsk(qa, index)}
              aria-pressed={activeQuestion === index}
              disabled={thinking}
            >
              {qa.question}
            </button>
          ))}
        </div>

        <form className="ai-assistant-input-bar" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="ai-assistant-input">
            Ask Dovroyn anything about your marketing pod
          </label>
          <input
            id="ai-assistant-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask Dovroyn anything about your marketing pod..."
            disabled={thinking}
          />
          <button type="submit" aria-label="Send message" disabled={thinking || !draft.trim()}>
            <Send size={16} strokeWidth={1.9} />
          </button>
        </form>

        <p className="ai-assistant-note">
          Public assistant answers are general. Signed-in pod AI is separately grounded in that pod's own brand and campaign data.
        </p>
      </div>
    </section>
  );
}
