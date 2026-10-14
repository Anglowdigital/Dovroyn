import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { creativeImageCandidates, imageReferenceKey, latestCreativeReviewEntry, creativeReviewPayload, initialCreativeHeadline, creativeReviewIsCurrent } from '../../lib/creativeReview.js';
import { isCreativeOperationPending, runCreativeOperation, subscribeCreativeOperations } from '../../lib/creativeOperations.js';
import { saveCreativeDraft } from '../../lib/podRepository.js';
import { approveMetaArtworkReview, prepareMetaArtworkReview } from '../../lib/metaOrganic.js';

export default function CreativeReview(props) {
  return <CreativeReviewEditor key={`${props.podId}:${props.post?.id}`} {...props} />;
}

function CreativeReviewEditor({ podId, post, brandName, assets = [], sourceMedia = [], savedPreferences = [], accessToken, onNotice, onSaved, canReviewExactMetaArtwork = false }) {
  const candidates = creativeImageCandidates(assets, sourceMedia);
  const entry = latestCreativeReviewEntry(savedPreferences, podId, post?.id);
  // An unrelated post can replace the shared array and reparse string-valued
  // JSON. Hydrate only when this post's persisted revision actually changes.
  const savedValue = JSON.stringify(entry?.value || null);
  const saved = useMemo(() => entry?.value || null, [entry?.row.id, entry?.row.created_at, entry?.row.updated_at, savedValue]);
  const [headline, setHeadline] = useState(() => saved?.headline ?? initialCreativeHeadline(post?.content));
  const [cta, setCta] = useState(() => saved?.call_to_action ?? post?.callToAction ?? '');
  const [imageKey, setImageKey] = useState(() => saved ? imageReferenceKey(saved.image) : candidates.find((image) => image.role !== 'logo')?.key || candidates[0]?.key || '');
  const [storedStatus, setStatus] = useState(() => creativeReviewIsCurrent(saved, post?.content || '') ? saved.status === 'approved' ? 'approved' : 'saved' : 'unsaved');
  const [contentSnapshot, setContentSnapshot] = useState(() => saved?.content_snapshot);
  const currentContent = useRef(post?.content || '');
  currentContent.current = post?.content || '';
  const status = contentSnapshot === currentContent.current ? storedStatus : 'unsaved';
  const [localBusy, setBusy] = useState(false);
  const sharedBusy = useSyncExternalStore(subscribeCreativeOperations, () => isCreativeOperationPending(podId, post?.id), () => false);
  const busy = localBusy || sharedBusy;
  const [savingDraft, setSavingDraft] = useState(false);
  const [prepared, setPrepared] = useState(null);
  const [renderLoaded, setRenderLoaded] = useState(false);
  const [error, setError] = useState('');
  const [failedImage, setFailedImage] = useState('');
  const active = useRef(true);
  const inFlight = useRef(false);
  const previewRequest = useRef(0);
  const didInvalidate = useRef(false);
  const localEdits = useRef(false);
  const fieldId = useId();
  const selected = candidates.find((image) => image.key === imageKey);
  const missingImage = Boolean(imageKey && (!selected || failedImage === imageKey));
  const currentFingerprint = JSON.stringify({
    postId: post?.id || '',
    canReviewExactMetaArtwork,
    caption: currentContent.current,
    headline: headline.trim(),
    cta: cta.trim(),
    imageKey,
    imageReference: selected?.reference || null,
    accountTargets: post?.targetAccounts || [],
  });
  const currentFingerprintRef = useRef(currentFingerprint);
  currentFingerprintRef.current = currentFingerprint;
  const preparedCurrent = prepared?.fingerprint === currentFingerprint ? prepared : null;
  const canApprovePrepared = Boolean(canReviewExactMetaArtwork && preparedCurrent?.preparationToken && renderLoaded && !busy);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!didInvalidate.current) { didInvalidate.current = true; return; }
    previewRequest.current += 1;
    setPrepared(null);
    setRenderLoaded(false);
    if (localEdits.current || !['draft', 'approved'].includes(saved?.status) || !creativeReviewIsCurrent(saved, currentContent.current)
      || saved.headline !== headline || saved.call_to_action !== cta || imageReferenceKey(saved.image) !== imageKey) setStatus('unsaved');
  }, [currentFingerprint]);
  useEffect(() => {
    // A prior editor can finish saving or approving after navigation. Restore
    // that confirmed revision only while this editor has no newer edits.
    if (!['draft', 'approved'].includes(saved?.status)) return;
    previewRequest.current += 1;
    setPrepared(null);
    setRenderLoaded(false);
    if (localEdits.current) { setStatus('unsaved'); return; }
    setHeadline(saved.headline ?? initialCreativeHeadline(post?.content));
    setCta(saved.call_to_action ?? post?.callToAction ?? '');
    setImageKey(imageReferenceKey(saved.image));
    setContentSnapshot(saved.content_snapshot);
    setStatus(creativeReviewIsCurrent(saved, currentContent.current) ? saved.status === 'approved' ? 'approved' : 'saved' : 'unsaved');
  }, [saved]);

  const edit = (setter) => (event) => { localEdits.current = true; previewRequest.current += 1; setter(event.target.value); setStatus('unsaved'); setPrepared(null); setRenderLoaded(false); setError(''); };
  async function saveDraft() {
    if (inFlight.current || isCreativeOperationPending(podId, post?.id) || !podId || !post?.id || !headline.trim() || missingImage) return;
    const savedFingerprint = currentFingerprint;
    const savedCaption = currentContent.current;
    previewRequest.current += 1;
    inFlight.current = true;
    setBusy(true);
    setSavingDraft(true);
    setStatus('unsaved');
    setPrepared(null);
    setRenderLoaded(false);
    setError('');
    try {
      const row = await saveCreativeDraft(podId, { ...post, content: savedCaption }, headline, cta, selected, brandName);
      // Even a stale editor response must reconcile the persisted draft revision:
      // the prior approval has been superseded in storage and in calendar review.
      onSaved?.(row);
      if (!active.current) return;
      if (currentFingerprintRef.current !== savedFingerprint) return;
      localEdits.current = false;
      setContentSnapshot(savedCaption);
      setStatus('saved');
      onNotice?.('Creative draft saved. Nothing has been approved, exported or published.');
    } catch (failure) {
      if (active.current) setError(failure?.message || 'Creative draft could not be saved. Please retry.');
    } finally {
      inFlight.current = false;
      if (active.current) { setBusy(false); setSavingDraft(false); }
    }
  }

  async function prepare() {
    if (!canReviewExactMetaArtwork || inFlight.current || isCreativeOperationPending(podId, post?.id) || !podId || !post?.id || missingImage) return;
    if (!accessToken) { setError('Sign in again before preparing artwork.'); return; }
    const requestId = previewRequest.current + 1;
    previewRequest.current = requestId;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setPrepared(null);
    try {
      const draft = creativeReviewPayload(post.id, headline, cta, selected, false, currentContent.current, { brandName });
      const result = await runCreativeOperation(podId, post.id, () => prepareMetaArtworkReview({
        accessToken,
        podId,
        postId: post.id,
        headline: draft.headline,
        callToAction: draft.call_to_action,
        image: draft.image,
        imageRole: draft.composition.image_role,
        brandName,
      }));
      if (!active.current || previewRequest.current !== requestId) return;
      setPrepared({ ...result, fingerprint: currentFingerprint });
      setRenderLoaded(false);
      onNotice?.('Rendered artwork is ready for exact review. Nothing has been approved or published.');
    } catch (failure) {
      if (active.current && previewRequest.current === requestId) { setError(failure?.message || 'Rendered artwork could not be prepared. Please retry.'); }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function approve() {
    if (!canReviewExactMetaArtwork || inFlight.current || isCreativeOperationPending(podId, post?.id) || !preparedCurrent?.preparationToken || !podId || !post?.id || !renderLoaded) return;
    if (!accessToken) { setError('Sign in again before approving artwork.'); return; }
    const approvalFingerprint = currentFingerprint;
    const approvalCaption = currentContent.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await runCreativeOperation(podId, post.id, () => approveMetaArtworkReview({
        accessToken,
        podId,
        postId: post.id,
        preparationToken: preparedCurrent.preparationToken,
        accountSnapshotFingerprint: preparedCurrent.accountSnapshotFingerprint,
      }));
      const stillCurrent = currentFingerprintRef.current === approvalFingerprint;
      if (!stillCurrent) localEdits.current = true;
      if (result.approval) onSaved?.(result.approval);
      if (!active.current || !stillCurrent) return;
      localEdits.current = false;
      setContentSnapshot(approvalCaption);
      setStatus('approved');
      setPrepared(null);
      setRenderLoaded(false);
      const exported = Array.isArray(result.exports) ? result.exports.filter(Boolean).length : 0;
      const failed = Array.isArray(result.failures) ? result.failures.length : 0;
      onNotice?.(failed ? `Creative approved, but ${failed} account export${failed === 1 ? '' : 's'} need review before publishing.` : `Creative approved and exported for ${exported} Meta account${exported === 1 ? '' : 's'}. Publishing approval is still separate.`);
    } catch (failure) {
      if (active.current && currentFingerprintRef.current === approvalFingerprint) setError(failure?.message || 'Creative approval could not be completed. Please retry.');
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="creative-review" aria-label={`Creative review for ${post?.platformName || 'social post'}`}>
    <div className="creative-review-heading"><div><span className="eyebrow">Your creative studio</span><h3>Make it yours.</h3></div><span className={`creative-status creative-status-${missingImage ? 'unsaved' : status}`} role="status">{missingImage ? 'Image unavailable · choose again' : status === 'approved' ? 'Approved creative' : status === 'saved' ? 'Draft saved' : 'Unsaved draft'}</span></div>
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
        {preparedCurrent?.image?.dataUrl && <figure className="creative-render-review"><img src={preparedCurrent.image.dataUrl} alt="Exact rendered artwork for approval" onLoad={() => setRenderLoaded(true)} onError={() => { setRenderLoaded(false); setError('Rendered JPEG preview could not be displayed. Prepare it again.'); }} /><figcaption>Exact server-rendered JPEG · {preparedCurrent.image.dimensions.width}×{preparedCurrent.image.dimensions.height}</figcaption></figure>}
        {!candidates.length && <p className="creative-review-note">No usable images yet. Add an image in Assets, or edit a typography draft.</p>}
        <p className="creative-review-note">Save your creative draft to keep edits when you leave. Saving an edited draft replaces its prior creative approval; existing calendar snapshots stay unchanged. Approval uses the exact rendered JPEG above. Editing the caption, headline, CTA, image or account targets requires a fresh render review. Publishing remains a separate approval.</p>
        {sharedBusy && !localBusy && <p role="status" className="creative-review-note">Finishing an earlier creative operation for this post…</p>}
        {error && <p role="alert" className="creative-review-error">{error}</p>}
        <div className="creative-review-actions"><button type="button" className="button button-secondary" disabled={busy || !headline.trim() || !post?.id || missingImage} onClick={saveDraft}>{savingDraft ? 'Saving draft…' : 'Save creative draft'}</button><button type="button" className="button button-secondary" disabled={!canReviewExactMetaArtwork || busy || !headline.trim() || !post?.id || missingImage} onClick={prepare}>{localBusy && !savingDraft ? 'Preparing…' : 'Prepare exact JPEG'}</button><button type="button" className="button button-primary" disabled={!canApprovePrepared} onClick={approve}>Approve rendered JPEG</button></div>
      </div>
    </div>
  </section>;
}
