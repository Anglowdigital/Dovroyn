import { useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { redirectToCheckout } from '../lib/stripe.js';
import { getPlanSelectionQuery } from '../lib/plans.js';

export default function CheckoutButton({ tier, billing = 'monthly', session, children = 'Subscribe' }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  if (!session?.access_token) {
    return <NavLink className="button button-primary" to={`/signup${getPlanSelectionQuery(tier, billing)}`}>Create account</NavLink>;
  }

  const checkout = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      await redirectToCheckout(tier, billing, { accessToken: session.access_token });
    } catch (checkoutError) {
      setError(checkoutError?.message || 'Checkout is temporarily unavailable. Please try again shortly.');
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
      <button className="button button-primary" type="button" onClick={checkout} disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Opening checkout…' : children}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}
