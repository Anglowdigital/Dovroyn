import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowUpRight, Globe2, Plus, Sparkles } from 'lucide-react';
import { supabase, supabaseConfigured } from '../lib/supabaseClient';
import { TIER_LIMITS } from '../lib/stripe';

export default function PodsPage({ session, subscription }) {
  const [pods, setPods] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabaseConfigured || !session?.user?.id) {
      setLoading(false);
      return;
    }
    supabase
      .from('pods')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setPods(data || []);
        setLoading(false);
      });
  }, [session?.user?.id]);

  const tier = subscription?.tier || 'free';
  const maxPods = TIER_LIMITS[tier]?.maxPods || 0;

  return (
    <div className="page-stack">
      <header className="section-header panel">
        <div>
          <p className="eyebrow">Pods ({pods.length}/{maxPods})</p>
          <h3>All AI marketing pods</h3>
          <p className="subtle">
            Create a dedicated pod for each brand, product, offer, or campaign.
          </p>
        </div>
        <NavLink className="button button-primary" to="/pods/new">
          Create Pod
        </NavLink>
      </header>


      <section className="pod-library-grid">
        {loading && <p className="subtle">Loading pods...</p>}

        {!loading && pods.length === 0 && (
          <article className="panel pod-library-empty">
            <h4>No pods yet</h4>
            <p className="subtle">
              Create your first AI marketing pod to get started.
            </p>
            <NavLink className="button button-primary" to="/pods/new">
              Create Pod
            </NavLink>
          </article>
        )}

        {pods.map((pod) => (
          <NavLink key={pod.id} className="panel pod-library-card" to={`/pods/${pod.id}`}>
            <div className="pod-library-cover">
              <span><Sparkles size={19} /></span>
              <span className="status-tag">{String(pod.status || 'created').replaceAll('_', ' ')}</span>
            </div>
            <div className="pod-library-body">
              <div>
                <p className="eyebrow">{pod.brand_name || pod.pod_type || 'Marketing pod'}</p>
                <h3>{pod.pod_name}</h3>
              </div>
              <div className="pod-library-meta">
                <span><Globe2 size={14} /> {pod.target_country || 'Region not set'}</span>
                <span>{pod.source_url ? 'Source ready' : 'Add source'}</span>
              </div>
              <div className="pod-library-open">Open pod <ArrowUpRight size={15} /></div>
            </div>
          </NavLink>
        ))}

        {!loading && pods.length < maxPods && (
          <NavLink className="pod-library-create" to="/pods/new">
            <span><Plus size={22} /></span>
            <strong>Create a new pod</strong>
            <small>Website, product, brand, offer, or campaign</small>
          </NavLink>
        )}
      </section>
    </div>
  );
}
