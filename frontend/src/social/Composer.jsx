'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Send, AlertTriangle, UploadCloud, Film, X, Link2, Check, Globe,
  ThumbsUp, MessageCircle, Repeat2, Share2, Heart, Bookmark,
  PlayCircle, Image as ImageIcon, Sparkles, Clock, Hash
} from 'lucide-react';
import { SOCIAL_API_BASE } from './api';
import { API_BASE } from '../apiBase';
import { PlatformIcon } from './PlatformIcon';
import { Page, PageBar, PageBody } from '../ui/page';
import { Button, Panel, PanelHeader, Input, Textarea, Field, Banner, EmptyState, cx } from '../ui';
import { channelColor, channelLabel, ChannelTile } from '../ui/channel';

// Per-platform limits this composer actually warns about — kept to what
// the connected adapters really enforce, not a guessed list for
// platforms this app can't publish to yet (Facebook feed posts cap at
// 63,206 chars, high enough that it's not worth a warning here).
const CHAR_LIMITS = {
  youtube: { limit: 100, note: 'YouTube has no text-only post — this becomes a video title (truncated to 100 chars) plus description; a video file is required.' },
  google_business: { limit: 1500, note: 'Google Business Profile Local Posts cap at 1500 characters.' },
  instagram: { limit: 2200, note: 'Instagram has no text-only post — attach an image or video; captions cap at 2200 characters.' },
  linkedin: { limit: 3000, note: 'LinkedIn posts (personal profile only) cap at 3000 characters.' }
};

let mediaItemSeq = 0;

/* ------------------------------------------------------------- previews */

function PreviewBody({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <div className="px-3 py-2 text-xs text-subtle">What do you want to say?</div>;
  return (
    <div>
      <div className={cx('px-3 py-2 text-xs text-ink leading-relaxed whitespace-pre-wrap', !expanded && 'line-clamp-5')}>
        {text}
      </div>
      {text.length > 200 && (
        <button
          type="button"
          className="px-3 pb-2 text-[11px] text-muted hover:text-ink"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Show less' : '…more'}
        </button>
      )}
    </div>
  );
}

function PreviewMedia({ media, square, placeholder }) {
  if (!media) {
    if (!placeholder) return null;
    return (
      <div
        className={cx(
          'bg-sunken border-y border-hairline flex flex-col items-center justify-center gap-1.5 text-subtle',
          square ? 'aspect-square' : 'aspect-video'
        )}
      >
        <ImageIcon size={20} />
        <span className="text-[11px]">{placeholder}</span>
      </div>
    );
  }
  return (
    <div className={cx('bg-sunken border-y border-hairline overflow-hidden', square ? 'aspect-square' : '')}>
      {media.mediaType === 'video' ? (
        <video src={media.previewSrc} muted className="w-full h-full object-cover" />
      ) : (
        <img src={media.previewSrc} alt="" className="w-full h-full object-cover" />
      )}
    </div>
  );
}

function PreviewHead({ platform, name, meta }) {
  return (
    <div className="px-3 py-2.5 flex items-center gap-2.5">
      <span
        className="w-8 h-8 rounded-full flex items-center justify-center text-white shrink-0"
        style={{ background: channelColor(platform) }}
      >
        <PlatformIcon platform={platform} size={15} />
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium text-ink truncate">{name}</div>
        {meta && <div className="text-[11px] text-subtle flex items-center gap-1">{meta}</div>}
      </div>
    </div>
  );
}

function PreviewActions({ items }) {
  return (
    <div className="px-3 py-2 border-t border-hairline flex items-center justify-around text-muted">
      {items.map(({ icon: Icon, label }) => (
        <span key={label} className="flex items-center gap-1.5 text-[11px]">
          <Icon size={14} /> {label}
        </span>
      ))}
    </div>
  );
}

function LinkedInPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <>
      <PreviewHead
        platform="linkedin"
        name={accountLabel || 'Your LinkedIn profile'}
        meta={<>{timestampLabel} · <Globe size={10} /></>}
      />
      <PreviewBody text={content} />
      <PreviewMedia media={media} />
      <PreviewActions
        items={[
          { icon: ThumbsUp, label: 'Like' },
          { icon: MessageCircle, label: 'Comment' },
          { icon: Repeat2, label: 'Repost' },
          { icon: Send, label: 'Send' }
        ]}
      />
    </>
  );
}

function FacebookPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <>
      <PreviewHead
        platform="facebook"
        name={accountLabel || 'Your Facebook page'}
        meta={<>{timestampLabel} · <Globe size={10} /></>}
      />
      <PreviewBody text={content} />
      <PreviewMedia media={media} />
      <PreviewActions
        items={[
          { icon: ThumbsUp, label: 'Like' },
          { icon: MessageCircle, label: 'Comment' },
          { icon: Share2, label: 'Share' }
        ]}
      />
    </>
  );
}

function InstagramPreview({ accountLabel, content, media }) {
  return (
    <>
      <PreviewHead platform="instagram" name={accountLabel || 'your_page'} />
      <PreviewMedia media={media} square placeholder="Instagram requires a photo or video" />
      <div className="px-3 py-2 flex items-center justify-between text-ink">
        <span className="flex items-center gap-3">
          <Heart size={17} />
          <MessageCircle size={17} />
          <Send size={17} />
        </span>
        <Bookmark size={17} />
      </div>
      {content && (
        <p className="px-3 pb-3 text-xs text-ink leading-relaxed line-clamp-2">
          <strong className="font-medium">{accountLabel || 'your_page'}</strong> {content}
        </p>
      )}
    </>
  );
}

function YouTubePreview({ accountLabel, content, media, timestampLabel }) {
  const title = content ? content.slice(0, 100) : 'Video title';
  return (
    <>
      <div className="relative aspect-video bg-sunken border-b border-hairline overflow-hidden flex items-center justify-center">
        {media ? (
          media.mediaType === 'video' ? (
            <video src={media.previewSrc} muted className="w-full h-full object-cover" />
          ) : (
            <img src={media.previewSrc} alt="" className="w-full h-full object-cover" />
          )
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-subtle">
            <Film size={20} />
            <span className="text-[11px]">Video required for YouTube</span>
          </div>
        )}
        <PlayCircle size={40} className="absolute text-white/90" />
      </div>
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span
          className="w-8 h-8 rounded-full flex items-center justify-center text-white shrink-0"
          style={{ background: channelColor('youtube') }}
        >
          <PlatformIcon platform="youtube" size={15} />
        </span>
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink line-clamp-2">{title}</div>
          <div className="text-[11px] text-subtle mt-0.5">
            {accountLabel || 'Your channel'} · {timestampLabel}
          </div>
        </div>
      </div>
    </>
  );
}

function GoogleBusinessPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <>
      <PreviewMedia media={media} placeholder="Add a photo (optional)" />
      <PreviewHead
        platform="google_business"
        name={accountLabel || 'Your business'}
        meta={`Local post · ${timestampLabel}`}
      />
      <PreviewBody text={content} />
      <div className="px-3 pb-3">
        <span className="text-[11px] font-medium text-brand">Learn more</span>
      </div>
    </>
  );
}

const PREVIEW_COMPONENTS = {
  linkedin: LinkedInPreview,
  facebook: FacebookPreview,
  instagram: InstagramPreview,
  youtube: YouTubePreview,
  google_business: GoogleBusinessPreview
};

/* ============================================================== Composer */

function Composer({ authFetch }) {
  const [accounts, setAccounts] = useState(null);
  const [brand, setBrand] = useState('infopace');
  const [content, setContent] = useState('');
  // Uploaded/attached media — { id, url, previewSrc, mediaType, uploading, error }.
  // Kept separate from the pasted-URL fallback field so an in-flight upload
  // never silently drops a URL someone was mid-typing, and vice versa.
  const [mediaItems, setMediaItems] = useState([]);
  const [pastedUrl, setPastedUrl] = useState('');
  const [showUrlField, setShowUrlField] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [mode, setMode] = useState('now'); // 'now' | 'schedule'
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [previewPlatform, setPreviewPlatform] = useState(null);
  const fileInputRef = useRef(null);

  // AI Assist — a drafting aid, not an autonomous poster. Generating a
  // draft only fills the same `content` textarea manual mode uses; the
  // human still reviews/edits it and still presses Publish/Schedule
  // themselves. See backend/lib/ai.js for why this stays a single
  // drafting call rather than an agent that posts on its own.
  const [composeMode, setComposeMode] = useState('manual'); // 'manual' | 'ai'
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [suggestingTags, setSuggestingTags] = useState(false);
  const [tagError, setTagError] = useState(null);

  useEffect(() => {
    authFetch(`${SOCIAL_API_BASE}/accounts`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load connected accounts.');
        // whatsapp has no publish() — it's messaging-only (see
        // backend/social/adapters/whatsapp.js) — so it's excluded here
        // rather than offered as a broadcast-post target that would just
        // fail when the queue tries to publish to it.
        setAccounts((data.accounts || []).filter((a) => a.status === 'active' && a.platform !== 'whatsapp'));
      })
      .catch((err) => {
        setResult({ type: 'error', text: err.message });
        setAccounts([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAccount = (id) =>
    setSelectedAccountIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectedAccounts = (accounts || []).filter((a) => selectedAccountIds.includes(a.id));
  const selectedPlatforms = Array.from(new Set(selectedAccounts.map((a) => a.platform)));

  const generateDraft = async () => {
    if (!brief.trim() || selectedPlatforms.length === 0) return;
    setGenerating(true);
    setAiError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/compose/draft`, {
        method: 'POST',
        body: JSON.stringify({
          brief: brief.trim(),
          platforms: selectedPlatforms,
          tone: tone.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate a draft.');
      setContent(data.draft);
    } catch (err) {
      setAiError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // A second, separately-triggered AI call (backend/lib/ai.js's
  // suggestHashtags) — works off whatever's already in the editor,
  // manual or AI-drafted, so regenerating hashtags never costs you a
  // caption you already liked.
  const suggestHashtags = async () => {
    if (!content.trim() || selectedPlatforms.length === 0) return;
    setSuggestingTags(true);
    setTagError(null);
    try {
      const res = await authFetch(`${API_BASE}/ai/compose/hashtags`, {
        method: 'POST',
        body: JSON.stringify({ content: content.trim(), platforms: selectedPlatforms })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not suggest hashtags.');
      const tags = (data.hashtags || []).join(' ');
      setContent((prev) => (tags ? `${prev.trim()}\n\n${tags}` : prev));
    } catch (err) {
      setTagError(err.message);
    } finally {
      setSuggestingTags(false);
    }
  };

  // Keep the active preview tab valid as selections change — defaults to
  // the first selected platform, and follows along if that one gets
  // deselected rather than showing a stale/empty tab.
  useEffect(() => {
    if (selectedPlatforms.length === 0) {
      setPreviewPlatform(null);
    } else if (!previewPlatform || !selectedPlatforms.includes(previewPlatform)) {
      setPreviewPlatform(selectedPlatforms[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlatforms.join(',')]);

  const uploadFiles = (files) => {
    Array.from(files).forEach((file) => {
      if (!/^image\/|^video\//.test(file.type)) {
        setResult({ type: 'error', text: `${file.name} isn't an image or video — skipped.` });
        return;
      }
      const id = ++mediaItemSeq;
      const previewSrc = URL.createObjectURL(file);
      const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      setMediaItems((prev) => [...prev, { id, previewSrc, mediaType, uploading: true, url: null, error: null }]);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('brand', brand);

      authFetch(`${SOCIAL_API_BASE}/media/upload`, { method: 'POST', body: formData })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed.');
          setMediaItems((prev) => prev.map((m) => (m.id === id ? { ...m, uploading: false, url: data.url } : m)));
        })
        .catch((err) => {
          setMediaItems((prev) =>
            prev.map((m) => (m.id === id ? { ...m, uploading: false, error: err.message } : m))
          );
        });
    });
  };

  const removeMediaItem = (id) => setMediaItems((prev) => prev.filter((m) => m.id !== id));

  const addPastedUrl = () => {
    const url = pastedUrl.trim();
    if (!url) return;
    const mediaType = /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? 'video' : 'image';
    setMediaItems((prev) => [
      ...prev,
      { id: ++mediaItemSeq, previewSrc: url, mediaType, uploading: false, url, error: null }
    ]);
    setPastedUrl('');
  };

  const mediaUrls = mediaItems.filter((m) => m.url).map((m) => m.url);
  const mediaUploading = mediaItems.some((m) => m.uploading);
  const firstMedia = mediaItems[0] || null;

  const submit = async (e) => {
    e.preventDefault();
    if (selectedAccountIds.length === 0) {
      setResult({ type: 'error', text: 'Select at least one connected account to post to.' });
      return;
    }
    if (mode === 'schedule' && !scheduledAt) {
      setResult({ type: 'error', text: 'Pick a date and time to schedule for.' });
      return;
    }
    if (mediaUploading) {
      setResult({ type: 'error', text: 'Still uploading media — wait for it to finish before posting.' });
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const res = await authFetch(`${SOCIAL_API_BASE}/posts`, {
        method: 'POST',
        body: JSON.stringify({
          brand,
          content,
          mediaUrls,
          targetPlatforms: selectedPlatforms,
          targetAccountIds: selectedAccountIds,
          scheduledAt: mode === 'now' ? new Date().toISOString() : new Date(scheduledAt).toISOString()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not schedule post.');
      setResult({
        type: 'success',
        text:
          mode === 'now'
            ? 'Post queued to publish now — check Posts for its status.'
            : 'Post scheduled — check Posts for its status.'
      });
      setContent('');
      setMediaItems([]);
      setPastedUrl('');
      setSelectedAccountIds([]);
      setScheduledAt('');
      setMode('now');
    } catch (err) {
      setResult({ type: 'error', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const timestampLabel =
    mode === 'now'
      ? 'Just now'
      : scheduledAt
      ? new Date(scheduledAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : 'Scheduled';

  const activePreviewAccount = selectedAccounts.find((a) => a.platform === previewPlatform);
  const ActivePreview = previewPlatform ? PREVIEW_COMPONENTS[previewPlatform] : null;
  const overLimit = selectedPlatforms.filter((p) => CHAR_LIMITS[p] && content.length > CHAR_LIMITS[p].limit);

  return (
    <Page>
      <form onSubmit={submit} className="contents">
        <PageBar
          title="Compose"
          actions={
            <Button
              type="submit"
              variant="primary"
              icon={mode === 'now' ? Send : Clock}
              loading={submitting}
              disabled={mediaUploading}
            >
              {mediaUploading ? 'Uploading media…' : mode === 'now' ? 'Publish now' : 'Schedule post'}
            </Button>
          }
        />

        <PageBody>
          {result && <Banner tone={result.type === 'success' ? 'success' : 'danger'}>{result.text}</Banner>}

          {accounts !== null && accounts.length === 0 && (
            <Banner tone="warning">No channels connected yet — connect one first and it appears here.</Banner>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-5 items-start">
            {/* ------------------------------------------------ editor */}
            <Panel>
              {/* account picker */}
              <div className="px-4 py-3 border-b border-hairline flex items-center gap-2 flex-wrap">
                {(accounts || []).map((a) => {
                  const selected = selectedAccountIds.includes(a.id);
                  return (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => toggleAccount(a.id)}
                      title={`${channelLabel(a.platform)} — ${a.account_label || a.id}`}
                      className={cx(
                        'relative h-8 pl-1.5 pr-2.5 rounded-ui border flex items-center gap-2 text-xs transition-colors',
                        selected
                          ? 'bg-brand-subtle border-brand/30 text-ink font-medium'
                          : 'bg-card border-hairline text-muted hover:bg-canvas hover:text-ink'
                      )}
                    >
                      <span className="relative">
                        <ChannelTile platform={a.platform} size={22} />
                        {selected && (
                          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-brand text-white flex items-center justify-center ring-2 ring-card">
                            <Check size={8} />
                          </span>
                        )}
                      </span>
                      <span className="truncate max-w-[140px]">{a.account_label || channelLabel(a.platform)}</span>
                    </button>
                  );
                })}
                {accounts === null && <span className="text-xs text-subtle">Loading channels…</span>}
              </div>

              {/* manual / AI assist */}
              <div className="px-4 pt-3 flex items-center gap-1 p-0.5">
                <div className="flex items-center gap-1 p-0.5 rounded-ui bg-sunken border border-hairline">
                  <button
                    type="button"
                    onClick={() => setComposeMode('manual')}
                    className={cx(
                      'h-6 px-2.5 rounded text-[11px] font-medium transition-colors',
                      composeMode === 'manual' ? 'bg-card text-ink' : 'text-muted hover:text-ink'
                    )}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposeMode('ai')}
                    className={cx(
                      'h-6 px-2.5 rounded text-[11px] font-medium transition-colors flex items-center gap-1',
                      composeMode === 'ai' ? 'bg-card text-ink' : 'text-muted hover:text-ink'
                    )}
                  >
                    <Sparkles size={12} /> AI assist
                  </button>
                </div>
              </div>

              {composeMode === 'ai' && (
                <div className="mx-4 mt-3 p-3 rounded-ui bg-brand-subtle/60 border border-hairline flex flex-col gap-2">
                  <Textarea
                    rows={2}
                    placeholder="What do you want to post about? e.g. “Announce our Diwali sale — 20% off, ends Sunday”"
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Input
                      className="max-w-[220px]"
                      placeholder="Tone (optional) — e.g. playful"
                      value={tone}
                      onChange={(e) => setTone(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      icon={Sparkles}
                      loading={generating}
                      onClick={generateDraft}
                      disabled={!brief.trim() || selectedPlatforms.length === 0}
                    >
                      {generating ? 'Generating…' : 'Generate draft'}
                    </Button>
                    {selectedPlatforms.length === 0 && (
                      <span className="text-[11px] text-muted">
                        Select a channel first, so the draft fits the right platform.
                      </span>
                    )}
                  </div>
                  {aiError && <p className="text-[11px] text-danger">{aiError}</p>}
                  <p className="text-[11px] text-subtle">
                    The draft lands in the editor below — you review, edit and publish it yourself.
                  </p>
                </div>
              )}

              {/* editor */}
              <div className="p-4 pt-3">
                <Textarea
                  rows={9}
                  placeholder="What do you want to say?"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="text-[13px]"
                />

                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Button
                    type="button"
                    size="sm"
                    icon={Hash}
                    loading={suggestingTags}
                    onClick={suggestHashtags}
                    disabled={!content.trim() || selectedPlatforms.length === 0}
                  >
                    {suggestingTags ? 'Suggesting…' : 'Suggest hashtags'}
                  </Button>
                  {tagError && <span className="text-[11px] text-danger">{tagError}</span>}
                </div>

                {/* per-channel counters */}
                {selectedPlatforms.filter((p) => CHAR_LIMITS[p]).length > 0 && (
                  <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] tabular-nums">
                    {selectedPlatforms
                      .filter((p) => CHAR_LIMITS[p])
                      .map((p) => {
                        const over = content.length > CHAR_LIMITS[p].limit;
                        return (
                          <span key={p} className={over ? 'text-warning font-medium' : 'text-subtle'}>
                            {channelLabel(p)} {content.length}/{CHAR_LIMITS[p].limit}
                          </span>
                        );
                      })}
                  </div>
                )}

                {overLimit.map((p) => (
                  <p key={p} className="mt-2 flex items-start gap-1.5 text-[11px] text-warning leading-relaxed">
                    <AlertTriangle size={13} className="shrink-0 mt-px" />
                    {CHAR_LIMITS[p].note}
                  </p>
                ))}

                {/* media */}
                <div
                  className={cx(
                    'mt-4 rounded-ui border border-dashed px-4 py-5 flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors',
                    dragOver ? 'border-brand bg-brand-subtle' : 'border-hairline-strong bg-sunken/50 hover:bg-sunken'
                  )}
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
                  }}
                >
                  <UploadCloud size={18} className="text-muted" />
                  <span className="text-xs font-medium text-ink">Click to upload, or drag and drop</span>
                  <span className="text-[11px] text-subtle">Images or videos, up to 50MB each</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>

                {mediaItems.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    {mediaItems.map((m) => (
                      <div
                        key={m.id}
                        className="relative w-16 h-16 rounded-ui overflow-hidden border border-hairline bg-sunken"
                      >
                        {m.mediaType === 'video' ? (
                          <video src={m.previewSrc} muted className="w-full h-full object-cover" />
                        ) : (
                          <img src={m.previewSrc} alt="" className="w-full h-full object-cover" />
                        )}
                        {m.mediaType === 'video' && (
                          <span className="absolute bottom-1 left-1 px-1 rounded bg-black/60 text-white text-[9px] flex items-center gap-0.5">
                            <Film size={8} /> video
                          </span>
                        )}
                        {(m.uploading || m.error) && (
                          <span
                            className={cx(
                              'absolute inset-0 flex items-center justify-center text-[10px] font-medium bg-card/85',
                              m.error ? 'text-danger' : 'text-muted'
                            )}
                            title={m.error || undefined}
                          >
                            {m.error ? 'Failed' : 'Uploading…'}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeMediaItem(m.id)}
                          className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-3">
                  {showUrlField ? (
                    <div className="flex items-center gap-2">
                      <Link2 size={14} className="text-subtle shrink-0" />
                      <Input
                        placeholder="Paste an already-hosted media URL"
                        value={pastedUrl}
                        autoFocus
                        onChange={(e) => setPastedUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addPastedUrl();
                          }
                        }}
                      />
                      <Button type="button" size="sm" onClick={addPastedUrl}>
                        Add
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowUrlField(true)}
                      className="text-[11px] text-brand hover:underline inline-flex items-center gap-1"
                    >
                      <Link2 size={12} /> …or paste an already-hosted media URL
                    </button>
                  )}
                </div>
              </div>
            </Panel>

            {/* ------------------------------------- options + preview */}
            <div className="flex flex-col gap-5 xl:sticky xl:top-0">
              <Panel>
                <PanelHeader title="Publishing options" />
                <div className="p-4 flex flex-col gap-4">
                  <Field label="Brand">
                    <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
                  </Field>

                  <div className="flex flex-col gap-2">
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="mode"
                        checked={mode === 'now'}
                        onChange={() => setMode('now')}
                        className="mt-0.5 accent-[var(--color-brand)]"
                      />
                      <span className="text-xs font-medium text-ink">Publish now</span>
                    </label>

                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="mode"
                        checked={mode === 'schedule'}
                        onChange={() => setMode('schedule')}
                        className="mt-0.5 accent-[var(--color-brand)]"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-ink">Schedule for a specific date</span>
                        {mode === 'schedule' && (
                          <span className="block mt-2">
                            <Input
                              type="datetime-local"
                              value={scheduledAt}
                              onChange={(e) => setScheduledAt(e.target.value)}
                            />
                            <span className="block text-[11px] text-subtle mt-1">
                              In your browser’s timezone (
                              {Intl.DateTimeFormat().resolvedOptions().timeZone}).
                            </span>
                          </span>
                        )}
                      </span>
                    </label>
                  </div>

                  {selectedAccounts.length > 0 && (
                    <p className="text-[11px] text-muted leading-relaxed border-t border-hairline pt-3">
                      Posting to {selectedAccounts.map((a) => a.account_label || a.id).join(', ')}
                    </p>
                  )}
                </div>
              </Panel>

              <Panel className="overflow-hidden">
                <PanelHeader
                  title="Post preview"
                  action={
                    selectedPlatforms.length > 1 && (
                      <div className="flex items-center gap-1">
                        {selectedPlatforms.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setPreviewPlatform(p)}
                            title={channelLabel(p)}
                            className={cx(
                              'w-6 h-6 rounded flex items-center justify-center border transition-colors',
                              previewPlatform === p
                                ? 'bg-canvas border-hairline'
                                : 'border-transparent text-subtle hover:text-ink'
                            )}
                            style={previewPlatform === p ? { color: channelColor(p) } : undefined}
                          >
                            <PlatformIcon platform={p} size={13} />
                          </button>
                        ))}
                      </div>
                    )
                  }
                />
                {!ActivePreview ? (
                  <EmptyState
                    icon={ImageIcon}
                    title="Nothing to preview yet"
                    description="Select a channel above to see exactly how this post will look there."
                  />
                ) : (
                  <div className="p-4">
                    <div className="rounded-ui border border-hairline overflow-hidden bg-card">
                      <ActivePreview
                        accountLabel={
                          activePreviewAccount
                            ? activePreviewAccount.account_label || activePreviewAccount.id
                            : channelLabel(previewPlatform)
                        }
                        content={content}
                        media={firstMedia}
                        timestampLabel={timestampLabel}
                      />
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          </div>
        </PageBody>
      </form>
    </Page>
  );
}

export default Composer;
