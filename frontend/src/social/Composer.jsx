import React, { useEffect, useRef, useState } from 'react';
import {
  Send, AlertTriangle, UploadCloud, Film, X, Link2, Check, Globe,
  ThumbsUp, MessageCircle, Repeat2, Share2, Heart, Bookmark,
  PlayCircle, Image as ImageIcon
} from 'lucide-react';
import { SOCIAL_API_BASE, PLATFORM_LABELS, PLATFORM_COLORS } from './api';
import { PlatformIcon, PlatformIconButton } from './PlatformIcon';

// Per-platform limits this composer actually warns about — kept to what
// the connected adapters really enforce, not a guessed list for
// platforms this app can't publish to yet (Facebook feed posts cap at
// 63,206 chars, high enough that it's not worth a warning here).
const CHAR_LIMITS = {
  youtube: { field: 'title', limit: 100, note: 'YouTube has no text-only post — this becomes a video title (truncated to 100 chars) plus description; a video file is required.' },
  google_business: { field: 'Local Post summary', limit: 1500, note: 'Google Business Profile Local Posts cap at 1500 characters.' },
  instagram: { field: 'caption', limit: 2200, note: 'Instagram has no text-only post — attach an image or video URL; captions cap at 2200 characters.' },
  linkedin: { field: 'commentary', limit: 3000, note: 'LinkedIn posts (personal profile only) cap at 3000 characters.' }
};

let mediaItemSeq = 0;

// Collapses long preview text to 5 lines with a working "...more" toggle —
// same idea as the real feed UIs this is mimicking, not just decoration.
function PreviewBody({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <div className="preview-body" style={{ color: 'var(--text-muted)' }}>What do you want to say?</div>;
  return (
    <div>
      <div className={`preview-body ${expanded ? '' : 'clamped'}`}>{text}</div>
      {text.length > 200 && (
        <button type="button" className="preview-more" style={{ margin: '0 1rem 0.5rem' }} onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Show less' : '...more'}
        </button>
      )}
    </div>
  );
}

function PreviewMedia({ media, square, placeholder }) {
  if (!media) {
    if (!placeholder) return null;
    return (
      <div className={`preview-media ${square ? 'square' : ''}`}>
        <div className="preview-media-empty"><ImageIcon size={22} /><span>{placeholder}</span></div>
      </div>
    );
  }
  return (
    <div className={`preview-media ${square ? 'square' : ''}`}>
      {media.mediaType === 'video' ? <video src={media.previewSrc} muted /> : <img src={media.previewSrc} alt="" />}
    </div>
  );
}

function LinkedInPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <div className="preview-card">
      <div className="preview-header">
        <div className="preview-avatar" style={{ background: PLATFORM_COLORS.linkedin }}><PlatformIcon platform="linkedin" size={16} /></div>
        <div>
          <div className="preview-name">{accountLabel || 'Your LinkedIn Page'}</div>
          <div className="preview-meta">{timestampLabel} · <Globe size={11} /></div>
        </div>
      </div>
      <PreviewBody text={content} />
      <PreviewMedia media={media} />
      <div className="preview-actions">
        <span className="preview-action"><ThumbsUp size={15} /> Like</span>
        <span className="preview-action"><MessageCircle size={15} /> Comment</span>
        <span className="preview-action"><Repeat2 size={15} /> Repost</span>
        <span className="preview-action"><Send size={15} /> Send</span>
      </div>
    </div>
  );
}

function FacebookPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <div className="preview-card">
      <div className="preview-header">
        <div className="preview-avatar" style={{ background: PLATFORM_COLORS.facebook }}><PlatformIcon platform="facebook" size={16} /></div>
        <div>
          <div className="preview-name">{accountLabel || 'Your Facebook Page'}</div>
          <div className="preview-meta">{timestampLabel} · <Globe size={11} /></div>
        </div>
      </div>
      <PreviewBody text={content} />
      <PreviewMedia media={media} />
      <div className="preview-actions">
        <span className="preview-action"><ThumbsUp size={15} /> Like</span>
        <span className="preview-action"><MessageCircle size={15} /> Comment</span>
        <span className="preview-action"><Share2 size={15} /> Share</span>
      </div>
    </div>
  );
}

function InstagramPreview({ accountLabel, content, media }) {
  return (
    <div className="preview-card">
      <div className="preview-header">
        <div className="preview-avatar" style={{ background: PLATFORM_COLORS.instagram }}><PlatformIcon platform="instagram" size={16} /></div>
        <div className="preview-name">{accountLabel || 'your_page'}</div>
      </div>
      <PreviewMedia media={media} square placeholder="Instagram requires a photo or video" />
      <div className="preview-icon-row">
        <div className="icons-left">
          <Heart size={19} /> <MessageCircle size={19} /> <Send size={19} />
        </div>
        <Bookmark size={19} />
      </div>
      {content && (
        <div className="preview-body" style={{ paddingTop: 0, WebkitLineClamp: 2, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          <strong>{accountLabel || 'your_page'}</strong> {content}
        </div>
      )}
    </div>
  );
}

function YouTubePreview({ accountLabel, content, media, timestampLabel }) {
  const title = content ? content.slice(0, 100) : 'Video title';
  return (
    <div className="preview-card">
      <div className="preview-media" style={{ aspectRatio: '16 / 9' }}>
        {media ? (media.mediaType === 'video' ? <video src={media.previewSrc} muted /> : <img src={media.previewSrc} alt="" />) : (
          <div className="preview-media-empty"><Film size={22} /><span>Video required for YouTube</span></div>
        )}
        <div className="preview-play-overlay"><PlayCircle size={44} color="#fff" fill="rgba(0,0,0,0.4)" /></div>
      </div>
      <div className="preview-header" style={{ alignItems: 'flex-start' }}>
        <div className="preview-avatar" style={{ background: PLATFORM_COLORS.youtube }}><PlatformIcon platform="youtube" size={16} /></div>
        <div>
          <div className="preview-name" style={{ WebkitLineClamp: 2, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{title}</div>
          <div className="preview-meta">{accountLabel || 'Your Channel'} · {timestampLabel}</div>
        </div>
      </div>
    </div>
  );
}

function GoogleBusinessPreview({ accountLabel, content, media, timestampLabel }) {
  return (
    <div className="preview-card">
      <PreviewMedia media={media} placeholder="Add a photo (optional)" />
      <div className="preview-header">
        <div className="preview-avatar" style={{ background: PLATFORM_COLORS.google_business }}><PlatformIcon platform="google_business" size={16} /></div>
        <div>
          <div className="preview-name">{accountLabel || 'Your Business'}</div>
          <div className="preview-meta">Local Post · {timestampLabel}</div>
        </div>
      </div>
      <PreviewBody text={content} />
      <div className="preview-cta">Learn more</div>
    </div>
  );
}

const PREVIEW_COMPONENTS = {
  linkedin: LinkedInPreview,
  facebook: FacebookPreview,
  instagram: InstagramPreview,
  youtube: YouTubePreview,
  google_business: GoogleBusinessPreview
};

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

  useEffect(() => {
    authFetch(`${SOCIAL_API_BASE}/accounts`)
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load connected accounts.');
        // whatsapp has no publish() — it's messaging-only (see
        // backend/social/adapters/whatsapp.js) — so it's excluded here
        // rather than offered as a broadcast-post target that would just
        // fail when the queue tries to publish to it.
        setAccounts((data.accounts || []).filter(a => a.status === 'active' && a.platform !== 'whatsapp'));
      })
      .catch(err => { setResult({ type: 'error', text: err.message }); setAccounts([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAccount = (id) => {
    setSelectedAccountIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const selectedAccounts = (accounts || []).filter(a => selectedAccountIds.includes(a.id));
  const selectedPlatforms = Array.from(new Set(selectedAccounts.map(a => a.platform)));

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
    Array.from(files).forEach(file => {
      if (!/^image\/|^video\//.test(file.type)) {
        setResult({ type: 'error', text: `${file.name} isn't an image or video — skipped.` });
        return;
      }
      const id = ++mediaItemSeq;
      const previewSrc = URL.createObjectURL(file);
      const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      setMediaItems(prev => [...prev, { id, previewSrc, mediaType, uploading: true, url: null, error: null }]);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('brand', brand);

      authFetch(`${SOCIAL_API_BASE}/media/upload`, { method: 'POST', body: formData })
        .then(async res => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed.');
          setMediaItems(prev => prev.map(m => (m.id === id ? { ...m, uploading: false, url: data.url } : m)));
        })
        .catch(err => {
          setMediaItems(prev => prev.map(m => (m.id === id ? { ...m, uploading: false, error: err.message } : m)));
        });
    });
  };

  const removeMediaItem = (id) => setMediaItems(prev => prev.filter(m => m.id !== id));

  const addPastedUrl = () => {
    const url = pastedUrl.trim();
    if (!url) return;
    const mediaType = /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? 'video' : 'image';
    setMediaItems(prev => [...prev, { id: ++mediaItemSeq, previewSrc: url, mediaType, uploading: false, url, error: null }]);
    setPastedUrl('');
  };

  const mediaUrls = mediaItems.filter(m => m.url).map(m => m.url);
  const mediaUploading = mediaItems.some(m => m.uploading);
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
      setResult({ type: 'success', text: mode === 'now' ? 'Post queued to publish now — check Posts for its status.' : 'Post scheduled — check Posts for its status.' });
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

  const timestampLabel = mode === 'now'
    ? 'Just now'
    : (scheduledAt ? new Date(scheduledAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Scheduled');

  const activePreviewAccount = selectedAccounts.find(a => a.platform === previewPlatform);
  const ActivePreview = previewPlatform ? PREVIEW_COMPONENTS[previewPlatform] : null;

  return (
    <div>
      <div className="header-container">
        <div className="title-area">
          <h1>Compose</h1>
          <p>Write once, preview per platform, and publish to every connected account you pick below.</p>
        </div>
      </div>

      {accounts !== null && accounts.length === 0 && (
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          No accounts connected yet — go to Connect Accounts first.
        </p>
      )}

      <form onSubmit={submit}>
        <div className="composer-grid">
          {/* ---- Editor ---- */}
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="account-picker-row">
              {(accounts || []).map(a => {
                const selected = selectedAccountIds.includes(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`account-chip ${selected ? 'selected' : ''}`}
                    onClick={() => toggleAccount(a.id)}
                    title={`${PLATFORM_LABELS[a.platform] || a.platform} — ${a.account_label || a.id}`}
                  >
                    <div className="account-chip-avatar-wrap">
                      <div className="account-chip-avatar" style={{ background: PLATFORM_COLORS[a.platform] || 'var(--text-muted)' }}>
                        <PlatformIcon platform={a.platform} size={18} />
                      </div>
                      {selected && <span className="account-chip-check"><Check size={10} /></span>}
                    </div>
                    <span className="account-chip-label">{PLATFORM_LABELS[a.platform] || a.platform}</span>
                  </button>
                );
              })}
            </div>

            <textarea
              className="form-control composer-textarea"
              placeholder="What do you want to say?"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />

            {selectedPlatforms.map(p => CHAR_LIMITS[p] && content.length > CHAR_LIMITS[p].limit && (
              <p key={p} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-warning)', fontSize: '0.82rem', marginTop: '0.6rem' }}>
                <AlertTriangle size={14} /> {PLATFORM_LABELS[p]}: {content.length}/{CHAR_LIMITS[p].limit} chars — {CHAR_LIMITS[p].note}
              </p>
            ))}
            {selectedPlatforms.filter(p => CHAR_LIMITS[p]).map(p => (
              <p key={`note-${p}`} style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '0.4rem' }}>{CHAR_LIMITS[p].note}</p>
            ))}

            <div style={{ marginTop: '1rem' }}>
              <div
                className={`media-upload-zone ${dragOver ? 'dragover' : ''}`}
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
                }}
              >
                <UploadCloud size={20} style={{ color: 'var(--accent-primary)', marginBottom: '0.3rem' }} />
                <div style={{ fontSize: '0.83rem', fontWeight: 600 }}>Click to upload, or drag and drop</div>
                <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>Images or videos, up to 50MB each</div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => { if (e.target.files && e.target.files.length) uploadFiles(e.target.files); e.target.value = ''; }}
                />
              </div>

              {mediaItems.length > 0 && (
                <div className="media-chip-row">
                  {mediaItems.map(m => (
                    <div className="media-chip" key={m.id}>
                      {m.mediaType === 'video' ? <video src={m.previewSrc} muted /> : <img src={m.previewSrc} alt="" />}
                      {m.mediaType === 'video' && (
                        <span style={{ position: 'absolute', bottom: 3, left: 3, background: 'rgba(15,18,30,0.65)', color: '#fff', borderRadius: 4, padding: '1px 4px', display: 'flex', alignItems: 'center', gap: 2, fontSize: '0.62rem' }}>
                          <Film size={10} /> video
                        </span>
                      )}
                      {m.uploading && <div className="media-chip-uploading">Uploading…</div>}
                      {m.error && <div className="media-chip-uploading" style={{ color: 'var(--accent-danger)' }} title={m.error}>Failed</div>}
                      <button type="button" className="media-chip-remove" onClick={() => removeMediaItem(m.id)}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: '0.6rem' }}>
                {showUrlField ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Link2 size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Paste an already-hosted media URL"
                      value={pastedUrl}
                      autoFocus
                      onChange={(e) => setPastedUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPastedUrl(); } }}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addPastedUrl}>Add</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowUrlField(true)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-primary)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <Link2 size={13} /> …or paste an already-hosted media URL
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ---- Publishing Options ---- */}
          <div className="composer-sticky">
            <div className="panel">
              <div className="panel-header"><h2 style={{ fontSize: '1rem' }}>Publishing Options</h2></div>

              <div className="form-group">
                <label>Brand</label>
                <input type="text" className="form-control" value={brand} onChange={(e) => setBrand(e.target.value)} />
              </div>

              <label className="publish-option">
                <input type="radio" name="mode" checked={mode === 'now'} onChange={() => setMode('now')} />
                <div>
                  <div className="publish-option-title">Publish Now</div>
                </div>
              </label>

              <label className="publish-option">
                <input type="radio" name="mode" checked={mode === 'schedule'} onChange={() => setMode('schedule')} />
                <div style={{ flex: 1 }}>
                  <div className="publish-option-title">Schedule for a Specific Date</div>
                  {mode === 'schedule' && (
                    <div className="publish-option-body">
                      <input
                        type="datetime-local"
                        className="form-control"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </label>

              {selectedAccounts.length > 0 && (
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>
                  Posting to {selectedAccounts.map(a => a.account_label || a.id).join(', ')}
                </p>
              )}

              {result && (
                <p style={{ color: result.type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)', fontSize: '0.85rem', marginTop: '1rem' }}>{result.text}</p>
              )}

              <button type="submit" className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center', marginTop: '1.25rem' }} disabled={submitting || mediaUploading}>
                <Send size={14} /> {submitting ? 'Publishing…' : mediaUploading ? 'Uploading media…' : mode === 'now' ? 'Publish Now' : 'Schedule Post'}
              </button>
            </div>
          </div>

          {/* ---- Post Preview ---- */}
          <div className="composer-sticky">
            <div className="panel">
              <div className="panel-header"><h2 style={{ fontSize: '1rem' }}>Post Preview</h2></div>

              {!ActivePreview ? (
                <div className="preview-empty-state">Select an account above to see how your post will look.</div>
              ) : (
                <>
                  {selectedPlatforms.length > 1 && (
                    <div className="preview-tabs platform-icon-tabs">
                      {selectedPlatforms.map(p => (
                        <PlatformIconButton key={p} platform={p} active={previewPlatform === p} onClick={() => setPreviewPlatform(p)} />
                      ))}
                    </div>
                  )}
                  <ActivePreview
                    accountLabel={activePreviewAccount ? (activePreviewAccount.account_label || activePreviewAccount.id) : PLATFORM_LABELS[previewPlatform]}
                    content={content}
                    media={firstMedia}
                    timestampLabel={timestampLabel}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

export default Composer;
