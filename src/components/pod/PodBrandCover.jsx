import { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '../../lib/supabaseClient';
import { getAssetPreview } from '../../lib/podRepository';

export default function PodBrandCover({ pod }) {
  const [media, setMedia] = useState({});
  useEffect(() => {
    let active = true;
    setMedia({});
    if (supabaseConfigured) {
      supabase.from('pod_assets').select('storage_path, asset_role').eq('pod_id', pod.id)
        .in('asset_role', ['logo', 'brand_photo']).order('created_at', { ascending: true })
        .then(async ({ data, error }) => {
          if (error || !active) return;
          const result = {};
          await Promise.all(['logo', 'brand_photo'].map(async role => {
            const asset = data?.find(item => item.asset_role === role);
            if (asset) result[role] = await getAssetPreview(asset.storage_path).catch(() => '');
          }));
          if (active) setMedia(result);
        }).catch(() => {});
    }
    return () => { active = false; };
  }, [pod.id]);
  const initials = (pod.brand_name || pod.pod_name || 'Pod').split(/\s+/).slice(0, 2).map(word => word[0]).join('');
  return <div className={`pod-library-cover ${media.brand_photo ? 'has-brand-photo' : ''}`}>
    {media.brand_photo && <img className="pod-library-cover-photo" src={media.brand_photo} alt="" onError={() => setMedia(current => ({ ...current, brand_photo: '' }))} />}
    <span className="pod-library-brandmark">{media.logo ? <img src={media.logo} alt={`${pod.brand_name || pod.pod_name} logo`} onError={() => setMedia(current => ({ ...current, logo: '' }))} /> : initials}</span>
    <span className="status-tag">{String(pod.status || 'created').replaceAll('_', ' ')}</span>
  </div>;
}
