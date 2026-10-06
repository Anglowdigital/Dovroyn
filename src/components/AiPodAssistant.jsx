import { useState } from 'react';
import { Sparkles } from 'lucide-react';

const ASSISTANT_QA = [
  {
    question: 'What could a skincare channel plan look like?',
    answer: 'Prepared example: Instagram for visual routines, TikTok for short educational videos, Pinterest for searchable guides, and email for existing customers. A real plan should use your audience, offer and approved claims. These are planning examples, not connected accounts or measured results.',
  },
  {
    question: 'Show me three fictional café caption ideas',
    answer: 'Prepared examples: “Your morning reset starts here — coffee and a quiet moment.” “Meet this week’s seasonal special.” “First sip, good company. Tag your coffee person.” Confirm the actual menu, availability and details before publishing.',
  },
  {
    question: 'What could a TikTok hook look like?',
    answer: 'Prepared example: “Three things to check before choosing your next skincare routine.” Start with a clear audience and topic, then deliver the promised information. Treat hook variations as drafts to review and test, not a guarantee of performance.',
  },
  {
    question: 'How could a consultant plan LinkedIn content?',
    answer: 'Prepared example: organise drafts around a practical framework, an industry question and a clearly labelled hypothetical example. Keep the audience and offer consistent. Use only verified case studies and client outcomes; a pod does not create evidence of results.',
  },
];

export default function AiPodAssistant() {
  const [activeQuestion, setActiveQuestion] = useState(0);
  const example = ASSISTANT_QA[activeQuestion];

  return (
    <section className="ai-assistant-section">
      <p className="eyebrow">Prepared local examples</p>
      <h2 className="section-title">See what a marketing pod could help you plan.</h2>
      <p className="lede ai-assistant-lede">
        Choose a prepared example. This preview sends no questions or brand data to an AI service.
      </p>
      <div className="panel ai-assistant-card" aria-label="Prepared Dovroyn examples">
        <div className="ai-assistant-header">
          <span className="ai-assistant-orb" aria-hidden="true">
            <span className="ai-assistant-orb-ring" />
            <Sparkles size={16} strokeWidth={1.75} />
          </span>
          <div>
            <p className="ai-assistant-name">Dovroyn</p>
            <p className="ai-assistant-subtitle">AI Marketing Pod · Local preview</p>
            <p className="ai-assistant-status">Prepared examples · No live AI</p>
          </div>
        </div>
        <div className="ai-assistant-chat" aria-live="polite" aria-atomic="true">
          <div className="ai-assistant-message-row ai-assistant-message-row-user">
            <p className="ai-assistant-bubble ai-assistant-bubble-user">{example.question}</p>
          </div>
          <div className="ai-assistant-message-row ai-assistant-message-row-assistant">
            <p className="ai-assistant-bubble ai-assistant-bubble-assistant">{example.answer}</p>
          </div>
        </div>
        <div className="ai-assistant-questions" role="group" aria-label="Choose a prepared example">
          {ASSISTANT_QA.map((qa, index) => (
            <button key={qa.question} type="button"
              className={`ai-assistant-question${activeQuestion === index ? ' active' : ''}`}
              onClick={() => setActiveQuestion(index)} aria-pressed={activeQuestion === index}>
              {qa.question}
            </button>
          ))}
        </div>
        <p className="ai-assistant-note">
          These examples are not personalised advice. Signed-in pod AI uses that pod’s own brand and campaign data.
        </p>
      </div>
    </section>
  );
}
