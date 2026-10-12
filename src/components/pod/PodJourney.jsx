const steps = [
  ['sources', 'Source inputs', 'Website, logo & photos'],
  ['direction', 'AI analysis', 'Review your direction'],
  ['socials', 'Platforms', 'Recommend & connect'],
  ['content', 'Creative review', 'Generate & edit drafts'],
  ['calendar', 'Calendar', 'Same campaign dates'],
];

export default function PodJourney({ activeTab }) {
  return <ol tabIndex={0} className="pod-journey" aria-label="Pod workflow order">
    {steps.map(([key, title, detail], index) => <li key={key} aria-current={activeTab === key ? 'step' : undefined}>
      <span>{String(index + 1).padStart(2, '0')}</span><div><strong>{title}</strong><small>{detail}</small></div>
    </li>)}
  </ol>;
}
