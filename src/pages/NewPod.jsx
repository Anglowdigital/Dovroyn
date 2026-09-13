import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import { canCreatePod, getPlan } from '../lib/plans';
import { uploadPodAsset } from '../lib/podRepository';
import { MAX_BRAND_PHOTOS, POD_SOURCE_TYPES, sourceNeedsUrl, validatePodSetup } from '../lib/podSetup';

export default function NewPodPage({ session, subscription }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    podName: '',
    brandName: '',
    sourceType: 'website',
    description: '',
    sourceUrl: '',
    targetCountry: 'Australia',
  });
  const [logoFile, setLogoFile] = useState(null);
  const [photoFiles, setPhotoFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const tier = subscription?.tier || 'free';
  const needsUrl = sourceNeedsUrl(form.sourceType);
  const selectedSource = POD_SOURCE_TYPES.find((source) => source.value === form.sourceType);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.podName.trim()) {
      setError('Pod name is required.');
      return;
    }
    const setupError = validatePodSetup({
      sourceType: form.sourceType,
      sourceUrl: form.sourceUrl,
      logoCount: logoFile ? 1 : 0,
      photoCount: photoFiles.length,
    });
    if (setupError) {
      setError(setupError);
      return;
    }
    setSaving(true);
    setError('');

    if (supabaseConfigured && session?.user?.id) {
      const { count, error: countError } = await supabase
        .from('pods')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.user.id)
        .neq('status', 'archived');
      if (countError) {
        setError('Dovroyn could not verify your pod allowance. Please try again.');
        setSaving(false);
        return;
      }
      if (!canCreatePod(tier, count || 0)) {
        setError(`${getPlan(tier).name} includes up to ${getPlan(tier).maxPods} active pod${getPlan(tier).maxPods === 1 ? '' : 's'}. Archive a pod or change plan before creating another.`);
        setSaving(false);
        return;
      }

      const { data, error: dbError } = await supabase
        .from('pods')
        .insert({
          user_id: session.user.id,
          pod_name: form.podName.trim(),
          brand_name: form.brandName.trim() || null,
          pod_type: form.sourceType === 'photos' ? 'images' : 'website',
          source_type: form.sourceType,
          source_url: form.sourceUrl.trim() || null,
          target_country: form.targetCountry,
          status: 'created',
        })
        .select()
        .single();

      if (dbError) {
        setError(dbError.message);
        setSaving(false);
        return;
      }

      if (form.sourceUrl.trim() || form.description.trim()) {
        await supabase.from('pod_sources').insert({
          pod_id: data.id,
          source_type: form.sourceType,
          source_url: form.sourceUrl.trim() || null,
          notes: form.description.trim() || null,
        });
      }

      await supabase.from('budgets').insert({ pod_id: data.id });
      try {
        await uploadPodAsset({ userId: session.user.id, podId: data.id, file: logoFile, assetRole: 'logo' });
        await Promise.all(photoFiles.map((file) => uploadPodAsset({
          userId: session.user.id,
          podId: data.id,
          file,
          assetRole: 'brand_photo',
        })));
      } catch (uploadError) {
        setError(`The pod was created, but its images did not finish uploading: ${uploadError.message}`);
        navigate(`/pods/${data.id}`);
        return;
      }
      navigate(`/pods/${data.id}`);
    } else {
      setError('Database not configured. Please check your setup and try again.');
      setSaving(false);
    }
  };

  return (
    <div className="page-stack">
      <header className="section-header panel">
        <div>
          <p className="eyebrow">Create Pod</p>
          <h3>Create a new AI marketing pod</h3>
          <p className="subtle">
            Each pod belongs to one brand source. After the first analysis, that source is permanently locked to this pod.
          </p>
        </div>
      </header>

      {error && (
        <p className="form-error" style={{ padding: '0.5rem' }}>{error}</p>
      )}

      <form className="card-form panel" onSubmit={handleCreate}>
        <div className="field-grid">
          <label>
            Pod Name
            <input
              value={form.podName}
              onChange={(e) => setForm((p) => ({ ...p, podName: e.target.value }))}
              placeholder="e.g. Aurora Skincare Launch"
              required
            />
          </label>

          <label>
            Brand Name
            <input
              value={form.brandName}
              onChange={(e) => setForm((p) => ({ ...p, brandName: e.target.value }))}
              placeholder="e.g. Aurora Skincare"
            />
          </label>

          <label>What should this pod analyse?</label>
          <div className="campaign-type-buttons" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
            {POD_SOURCE_TYPES.map((source) => (
              <button
                key={source.value}
                type="button"
                className={`button ${form.sourceType === source.value ? 'button-primary' : 'button-ghost'}`}
                onClick={() => setForm((previous) => ({ ...previous, sourceType: source.value, sourceUrl: source.value === 'photos' ? '' : previous.sourceUrl }))}
              >
                {source.label}
              </button>
            ))}
          </div>

          {needsUrl && (
            <label>
              One primary {selectedSource?.label.toLowerCase()} URL
              <input
                type="url"
                value={form.sourceUrl}
                onChange={(e) => setForm((p) => ({ ...p, sourceUrl: e.target.value }))}
                placeholder={selectedSource?.placeholder}
                required
              />
            </label>
          )}

          <label>
            Brand logo
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setLogoFile(event.target.files?.[0] || null)}
              required
            />
            <span className="subtle">One logo. It becomes part of this pod's locked brand analysis.</span>
          </label>

          <label>
            Brand or product photos — up to {MAX_BRAND_PHOTOS}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                if (files.length > MAX_BRAND_PHOTOS) {
                  setPhotoFiles([]);
                  setError(`Choose no more than ${MAX_BRAND_PHOTOS} photos.`);
                  event.target.value = '';
                  return;
                }
                setPhotoFiles(files);
                setError('');
              }}
              required={form.sourceType === 'photos'}
            />
            <span className="subtle">{photoFiles.length}/{MAX_BRAND_PHOTOS} selected.</span>
          </label>

          <label>
            Brief Description (optional)
            <textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="Anything the AI should know about this brand or campaign..."
            />
          </label>

          <label>
            Target Country
            <select
              value={form.targetCountry}
              onChange={(e) => setForm((p) => ({ ...p, targetCountry: e.target.value }))}
            >
              <option value="Australia">Australia</option>
              <option value="United States">United States</option>
              <option value="United Kingdom">United Kingdom</option>
              <option value="Canada">Canada</option>
              <option value="New Zealand">New Zealand</option>
              <option value="Other">Other</option>
            </select>
          </label>
        </div>

        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? 'Creating pod...' : 'Create Pod and Review Inputs'}
        </button>
      </form>
    </div>
  );
}
