import { useEffect, useId, useRef, useState } from 'react';
import { savePreferenceDecision } from '../../lib/podRepository';
import { creativeImageCandidates, imageReferenceKey, latestCreativeReview, creativeReviewPayload, initialCreativeHeadline, creativeReviewIsCurrent } from '../../lib/creativeReview.js';

export default function CreativeReview(props) {
  return <CreativeReviewEditor key={`${props.podId}:${props.post?.id}`} {...props} />;
}

function CreativeReviewEditor({ podId, post, brandName, assets = [], sourceMedia = [], savedPreferences = [], onNotice, onSaved }) {
  const candidates = creativeImageCandidates(assets, sourceMedia);
  const saved = latestCreativeReview(savedPreferences, podId, post?.id);
  const [headline, setHeadline] = useState(() => saved?.headline ?? initialCreativeHeadline(post?.content));
  const [cta, setCta] = useState(() => saved?.call_to_action ?? post?.callToAction ?? '');
  const [imageKey, setImageKey] = useState(() => saved ? imageReferenceKey(saved.image) : candidates.find((image) => image.role !== 'logo')?.key || candidates[0]?.key || '');
  const [storedStatus, setStatus] = useState(() => creativeReviewIsCurrent(saved, post?.content || '') ? saved.status === 'approved' ? 'approved' : 'saved' : 'unsaved');
  const [contentSnapshot, setContentSnapshot] = useState(() => saved?.content_snapshot);
  const currentContent = useRef(post?.content || '');
  currentContent.current = post?.content || '';
  const status = contentSnapshot === currentContent.current ? storedStatus : 'unsaved';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedImage, setFailedImage] = useState('');
  const active = useRef(true);
  const inFlight = useRef(false);
  const fieldId = useId();
  const selected = candidates.find((image) => image.key === imageKey);
  const missingImage = Boolean(imageKey && (!selected || failedImage === imageKey));
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const edit = (setter) => (event) => { setter(event.target.value); setStatus('unsaved'); setError(''); };
  async function save(approve) {
    if (inFlight.current || !podId || !post?.id || missingImage) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const payload = creativeReviewPayload(post.id, headline, cta, selected, approve, currentContent.current);
      const row = await savePreferenceDecision(podId, 'creative_review', payload);
      if (!row?.id) throw new Error('The creative save was not confirmed. Please retry.');
      if (!active.current) return;
      setContentSnapshot(payload.content_snapshot);
      setStatus(approve ? 'approved' : 'saved');
      onSaved?.(row);
      onNotice?.(currentContent.current !== payload.content_snapshot ? 'Saved the previous creative version. The updated caption needs fresh review.' : approve ? 'Creative approved and saved. Nothing has been published.' : 'Creative draft saved.');
    } catch (failure) {
      if (active.current) { setError(failure?.message || 'Creative could not be saved. Please retry.'); }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="creative-review" aria-label={`Creative review for ${post?.platformName || 'social post'}`}>
    <div className="creative-review-heading"><div><span className="eyebrow">Your creative studio</span><h3>Make it yours. Then approve.</h3></div><span className={`creative-status creative-status-${missingImage ? 'unsaved' : status}`} role="status">{missingImage ? 'Image unavailable · choose again' : status === 'approved' ? 'Approved creative' : status === 'saved' ? 'Draft saved' : 'Unsaved draft'}</span></div>
    <div className="creative-review-grid">
      <div className="creative-ad" aria-label="Ad draft preview">
        <div className="creative-ad-brand">{brandName || 'Your brand'}</div>
        {selected && failedImage !== imageKey && <img key={selected.key} className={`creative-ad-image${selected.role === 'logo' ? ' creative-ad-logo' : ''}`} src={selected.url} alt={selected.label} onError={() => setFailedImage(imageKey)} />}
        <div className="creative-ad-copy"><p className="creative-ad-headline">{headline || 'Add your headline'}</p>{cta && <span className="creative-ad-cta">{cta}<span aria-hidden="true"> ↗</span></span>}</div>
        <span className="creative-ad-footnote">{post?.platformName || 'Social'} · Draft preview</span>
      </div>
      <div className="creative-review-fields">
        <p>Use your own uploads or reviewed source imagery. Check image rights and every claim before approval.</p>
        <label htmlFor={`${fieldId}-headline`}>Headline</label><textarea id={`${fieldId}-headline`} rows={4} maxLength={350} value={headline} onChange={edit(setHeadline)} disabled={busy} />
        <label htmlFor={`${fieldId}-cta`}>Call to action</label><input id={`${fieldId}-cta`} maxLength={80} value={cta} onChange={edit(setCta)} disabled={busy} />
        <label htmlFor={`${fieldId}-image`}>Creative image</label><select id={`${fieldId}-image`} value={imageKey} onChange={edit(setImageKey)} disabled={busy}><option value="">Typography only</option>{missingImage && <option value={imageKey}>Previous image is unavailable</option>}{candidates.map((image) => <option key={image.key} value={image.key}>{image.role === 'logo' ? 'Logo · ' : ''}{image.label}</option>)}</select>
        {!candidates.length && <p className="creative-review-note">No usable images yet. Add an image in Assets, or save a typography draft.</p>}
        <p className="creative-review-note">Approval saves this creative in your pod. Scheduling and publishing are separate steps. Editing creates an unsaved draft and requires fresh approval.</p>
        {error && <p role="alert" className="creative-review-error">{error}</p>}
        <div className="creative-review-actions"><button type="button" className="button button-secondary" disabled={busy || !headline.trim() || !post?.id || missingImage} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save draft'}</button><button type="button" className="button button-primary" disabled={busy || !headline.trim() || !post?.id || missingImage} onClick={() => save(true)}>Approve creative</button></div>
      </div>
    </div>
  </section>;
}
