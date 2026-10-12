'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Link2, Unlink, HelpCircle } from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, AVAILABLE_PLATFORMS } from './api';
import { Page, PageBar, PageBody } from '../ui/page';
import {
  Button, IconButton, Panel, Input, Field, Chip, Banner, Skeleton, ConfirmDialog
} from '../ui';
import { ChannelTile, channelLabel } from '../ui/channel';

// What connecting each channel actually buys — shown on the card so the
// choice isn't just a logo and a button.
const CHANNEL_BLURB = {
  youtube: 'Publish videos and read channel analytics.',
  google_business: 'Post local updates and collect reviews into the inbox.',
  facebook: 'Publish to a page, and pull comments into the inbox.',
  instagram: 'Publish photos and reels, and pull comments and DMs in.',
  linkedin: 'Publish to a personal profile (page posting needs review).',
  whatsapp: 'Two-way messaging in the inbox. Messaging only — no posts.'
};

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

function ConnectAccounts({ authFetch }) {
  const [accounts, setAccounts] = useState(null);
  const [brand, setBrand] = useState('infopace');
  const [connectingPlatform, setConnectingPlatform] = useState(null);
  const [banner, setBanner] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);

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
        if (
          data.type === 'WA_EMBEDDED_SIGNUP' &&
          (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')
        ) {
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
    if (connected)
      setBanner({ type: 'success', text: `${PLATFORM_LABELS[connected] || connected} connected.` });
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
      const res = await authFetch(
        `${SOCIAL_API_BASE}/connect/${platform}?brand=${encodeURIComponent(brand.trim())}`
      );
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
              throw new Error(
                'Did not receive a WhatsApp Business Account selection from the signup popup — please try again.'
              );
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

  const disconnect = async (account) => {
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/accounts/${account.id}/disconnect`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not disconnect account.');
      loadAccounts();
    } catch (err) {
      setBanner({ type: 'error', text: err.message });
    } finally {
      setConfirmDisconnect(null);
    }
  };

  const accountsByPlatform = {};
  (accounts || []).forEach((a) => {
    if (a.status !== 'active') return;
    (accountsByPlatform[a.platform] = accountsByPlatform[a.platform] || []).push(a);
  });

  const totalConnected = Object.values(accountsByPlatform).reduce((n, list) => n + list.length, 0);

  return (
    <Page>
      <PageBar
        title="Channels"
        count={accounts === null ? undefined : `${totalConnected} connected`}
        actions={<IconButton icon={RefreshCw} label="Refresh" onClick={loadAccounts} />}
      />

      <PageBody>
        {banner && (
          <Banner
            tone={banner.type === 'success' ? 'success' : 'danger'}
            action={
              <Button size="sm" onClick={() => setBanner(null)}>
                Dismiss
              </Button>
            }
          >
            {banner.text}
          </Banner>
        )}

        <Panel className="p-4">
          <Field
            label="Brand"
            hint="Accounts are connected under a brand, so one workspace can run several."
            className="max-w-xs"
          >
            <Input placeholder="e.g. infopace" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
        </Panel>

        {accounts === null ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            <Skeleton className="h-40 rounded-card" />
            <Skeleton className="h-40 rounded-card" />
            <Skeleton className="h-40 rounded-card" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 items-start">
            {AVAILABLE_PLATFORMS.map((platform) => {
              const connected = accountsByPlatform[platform] || [];
              const busy = connectingPlatform === platform;
              return (
                <Panel key={platform}>
                  <div className="p-4 flex items-start gap-3">
                    <ChannelTile platform={platform} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-ink truncate">
                          {channelLabel(platform)}
                        </h3>
                        <Chip tone={connected.length > 0 ? 'success' : 'neutral'}>
                          {connected.length > 0 ? `${connected.length} connected` : 'Not connected'}
                        </Chip>
                      </div>
                      <p className="text-[11px] text-muted leading-relaxed mt-1">
                        {CHANNEL_BLURB[platform]}
                      </p>
                    </div>
                  </div>

                  {connected.length > 0 && (
                    <div className="border-t border-hairline">
                      {connected.map((a) => (
                        <div
                          key={a.id}
                          className="px-4 py-2.5 border-b border-hairline last:border-0 flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-ink truncate">
                              {a.account_label || a.id}
                            </div>
                            <div className="text-[11px] text-subtle flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-success" />
                              Token valid · brand {a.brand}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={Unlink}
                            onClick={() => setConfirmDisconnect(a)}
                          >
                            Disconnect
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="p-3 border-t border-hairline flex items-center gap-2 flex-wrap">
                    <Button
                      variant={connected.length > 0 ? 'secondary' : 'primary'}
                      size="sm"
                      icon={Link2}
                      loading={busy}
                      onClick={() => connect(platform)}
                    >
                      {busy
                        ? 'Redirecting…'
                        : connected.length > 0
                        ? 'Connect another'
                        : `Connect ${channelLabel(platform)}`}
                    </Button>
                    {platform === 'whatsapp' && (
                      <Button
                        size="sm"
                        icon={HelpCircle}
                        disabled={busy}
                        onClick={connectWhatsAppEmbedded}
                        title="Use this if webhook messages aren't arriving after a plain connect — it explicitly subscribes this app to the WABA's webhook events."
                      >
                        Embedded signup
                      </Button>
                    )}
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </PageBody>

      <ConfirmDialog
        open={!!confirmDisconnect}
        title="Disconnect this account?"
        body={`${
          confirmDisconnect?.account_label || 'This account'
        } will stop syncing, and any scheduled post already targeting it will fail until it's reconnected.`}
        confirmLabel="Disconnect"
        onCancel={() => setConfirmDisconnect(null)}
        onConfirm={() => disconnect(confirmDisconnect)}
      />
    </Page>
  );
}

export default ConnectAccounts;
