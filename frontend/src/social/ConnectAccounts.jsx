import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Link2, Unlink } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, AVAILABLE_PLATFORMS } from './api';

// Loads the Facebook JS SDK once (idempotent — safe to call on every
// mount). Needed only for WhatsApp's Embedded Signup button below; every
// other platform here uses the plain browser-redirect OAuth flow via
// connect() instead, which needs no SDK.
function loadFacebookSdk() {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve) => {
    window.fbAsyncInit = function () {
      window.FB.init({ appId: window.__whatsappSignupAppId, xfbml: false, version: 'v21.0' });
      resolve(window.FB);
    };
    if (document.getElementById('facebook-jssdk')) return;
    const js = document.createElement('script');
    js.id = 'facebook-jssdk';
    js.src = 'https://connect.facebook.net/en_US/sdk.js';
    document.body.appendChild(js);
  });
}

// Mirrors the Supabase Connection Manager panel's UX (App.jsx's
// currentView === 'settings' block) — same header-container/config-grid/
// config-card shapes, just OAuth-connect instead of paste-a-key.
function ConnectAccounts({ authFetch }) {
  const [accounts, setAccounts] = useState(null);
  const [brand, setBrand] = useState('infopace');
  const [connectingPlatform, setConnectingPlatform] = useState(null);
  const [banner, setBanner] = useState(null);

  // WhatsApp Embedded Signup's popup reports which WABA/phone number was
  // picked via a postMessage event (captured here), separately from
  // FB.login()'s own callback (which only gives the OAuth `code`) — both
  // pieces are needed together to call the backend, so the postMessage
  // listener below stashes them here for connectWhatsAppEmbedded() to
  // read once FB.login()'s callback fires.
  const embeddedSignupDataRef = useRef(null);

  useEffect(() => {
    const onMessage = (event) => {
      if (!event.origin || !event.origin.endsWith('facebook.com')) return;
      try {
        const data = JSON.parse(event.data);
        // Plain signups report 'FINISH'; onboarding an existing WhatsApp
        // Business App number via coexistence (featureType below) reports
        // 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' instead, and its data
        // can omit phone_number_id — completeEmbeddedSignup() on the
        // backend resolves that from waba_id when it's missing.
        if (data.type === 'WA_EMBEDDED_SIGNUP' && (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')) {
          embeddedSignupDataRef.current = data.data; // { phone_number_id?, waba_id }
        }
      } catch (err) {
        // not a WA_EMBEDDED_SIGNUP postMessage — ignore
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const loadAccounts = async () => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/accounts`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load connected accounts.');
      setAccounts(data.accounts || []);
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
      setAccounts([]);
    }
  };

  // OAuth callback lands the browser back on '/', carrying
  // ?social_connected=<platform> or ?social_error=<message> — surface it
  // once, then strip it from the URL so a refresh doesn't reshow it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('social_connected');
    const error = params.get('social_error');
    if (connected) setBanner({ type: 'success', text: `${PLATFORM_LABELS[connected] || connected} connected.` });
    if (error) setBanner({ type: 'error', text: error });
    if (connected || error) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (platform) => {
    if (!brand.trim()) {
      setBanner({ type: 'error', text: 'Enter a brand before connecting an account.' });
      return;
    }
    setConnectingPlatform(platform);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/connect/${platform}?brand=${encodeURIComponent(brand.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the connect flow.');
      window.location.href = data.url; // leaves the app for the platform's OAuth consent screen
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
      setConnectingPlatform(null);
    }
  };

  // Alternate WhatsApp connect path (see backend/routes/social.js's
  // /social/whatsapp/embedded-signup and whatsapp.js's
  // completeEmbeddedSignup() for why this exists): plain OAuth via
  // connect() above can read an already-connected WABA's data but never
  // reliably receives its webhook events, because nothing ever calls
  // POST /{waba-id}/subscribed_apps for it. Embedded Signup's popup lets
  // the business explicitly (re)share a WABA with this app, and
  // completeEmbeddedSignup() makes that subscribed_apps call as part of
  // finishing the connect — that's the actual fix, not the popup itself.
  const connectWhatsAppEmbedded = async () => {
    if (!brand.trim()) {
      setBanner({ type: 'error', text: 'Enter a brand before connecting an account.' });
      return;
    }
    setConnectingPlatform('whatsapp');
    try {
      const configRes = await authFetch(`${SOCIAL_API_BASE}/whatsapp/embedded-signup-config`);
      const config = await configRes.json();
      if (!configRes.ok) throw new Error(config.error || 'WhatsApp Embedded Signup is not configured.');

      window.__whatsappSignupAppId = config.appId;
      const FB = await loadFacebookSdk();

      embeddedSignupDataRef.current = null;
      FB.login(
        async (response) => {
          try {
            if (!response.authResponse || !response.authResponse.code) {
              throw new Error('WhatsApp Embedded Signup was cancelled or did not complete.');
            }
            if (!embeddedSignupDataRef.current || !embeddedSignupDataRef.current.waba_id) {
              throw new Error('Did not receive a WhatsApp Business Account selection from the signup popup — please try again.');
            }
            const { waba_id: wabaId, phone_number_id: phoneNumberId } = embeddedSignupDataRef.current;

            const res = await authFetch(`${SOCIAL_API_BASE}/whatsapp/embedded-signup`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: response.authResponse.code, wabaId, phoneNumberId, brand: brand.trim() })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not complete WhatsApp Embedded Signup.');

            setBanner({ type: 'success', text: `${data.accountLabel} connected via Embedded Signup.` });
            loadAccounts();
          } catch (err) {
            setBanner({ type: 'error', text: err.message });
          } finally {
            setConnectingPlatform(null);
          }
        },
        {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          // 'whatsapp_business_app_onboarding' is what actually shows the
          // "connect your existing WhatsApp Business app number" (coexistence)
          // screen — an empty featureType skips straight past it, which is
          // why a number already active in the WhatsApp Business App on a
          // phone could never be linked this way before.
          extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
        }
      );
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
      setConnectingPlatform(null);
    }
  };

  const disconnect = async (accountId) => {
    if (!confirm('Disconnect this account? Scheduled posts already targeting it will fail until reconnected.')) return;
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/accounts/${accountId}/disconnect`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not disconnect account.');
      loadAccounts();
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const accountsByPlatform = {};
  (accounts || []).forEach(a => {
    if (a.status !== 'active') return;
    (accountsByPlatform[a.platform] = accountsByPlatform[a.platform] || []).push(a);
  });

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Connect Accounts</h1>
          <p>Connect real platform accounts to publish, monitor, and reply from this dashboard.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadAccounts}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {banner && (
        <p style={{ color: banner.type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)', marginBottom: '1rem' }}>
          {banner.text}
        </p>
      )}

      <div className="form-group" style={{ maxWidth: 320, marginBottom: '1.5rem' }}>
        <label>Brand</label>
        <input
          type="text"
          className="form-control"
          placeholder="e.g. infopace"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />
      </div>

      {accounts === null ? (
        <div className="trend-chart-empty">Loading connected accounts...</div>
      ) : (
        <div className="config-grid">
          {AVAILABLE_PLATFORMS.map(platform => {
            const connected = accountsByPlatform[platform] || [];
            return (
              <div className="config-card" key={platform}>
                <div className="config-header">
                  <h3>{PLATFORM_LABELS[platform]}</h3>
                  <span className={`mode-badge ${connected.length > 0 ? 'live' : 'mock'}`}>
                    {connected.length > 0 ? `${connected.length} connected` : 'not connected'}
                  </span>
                </div>

                {connected.map(a => (
                  <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border-color)' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{a.account_label || a.id}</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Brand: {a.brand}</div>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => disconnect(a.id)}>
                      <Unlink size={14} /> Disconnect
                    </button>
                  </div>
                ))}

                <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={connectingPlatform === platform}
                    onClick={() => connect(platform)}
                  >
                    <Link2 size={14} /> {connectingPlatform === platform
                      ? 'Redirecting...'
                      : connected.length > 0 ? `Connect another ${PLATFORM_LABELS[platform]} account` : `Connect ${PLATFORM_LABELS[platform]}`}
                  </button>
                  {platform === 'whatsapp' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={connectingPlatform === platform}
                      onClick={connectWhatsAppEmbedded}
                      title="Use this if webhook messages aren't arriving after a plain Connect WhatsApp — it explicitly subscribes this app to the WABA's webhook events."
                    >
                      <Link2 size={14} /> {connectingPlatform === platform ? 'Connecting...' : 'Connect via Embedded Signup'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ConnectAccounts;
