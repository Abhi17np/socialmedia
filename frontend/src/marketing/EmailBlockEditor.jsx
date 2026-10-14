'use client';

import { Heading1, Type, Image as ImageIcon, MousePointerClick, Minus, MoveVertical, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, IconButton, Input, Textarea } from '../ui';

const BLOCK_DEFS = {
  heading: { label: 'Heading', icon: Heading1, create: () => ({ type: 'heading', text: 'Heading text' }) },
  text: { label: 'Text', icon: Type, create: () => ({ type: 'text', text: 'Write something…' }) },
  image: { label: 'Image', icon: ImageIcon, create: () => ({ type: 'image', src: '', alt: '' }) },
  button: { label: 'Button', icon: MousePointerClick, create: () => ({ type: 'button', label: 'Shop now', href: 'https://' }) },
  divider: { label: 'Divider', icon: Minus, create: () => ({ type: 'divider' }) },
  spacer: { label: 'Spacer', icon: MoveVertical, create: () => ({ type: 'spacer', height: 24 }) }
};

function BlockFields({ block, onChange }) {
  switch (block.type) {
    case 'heading':
    case 'text':
      return <Textarea rows={block.type === 'heading' ? 1 : 3} value={block.text || ''} onChange={(e) => onChange({ ...block, text: e.target.value })} placeholder="Use {{firstName|there}} for merge tags" />;
    case 'image':
      return (
        <div className="flex flex-col gap-2">
          <Input value={block.src || ''} onChange={(e) => onChange({ ...block, src: e.target.value })} placeholder="Image URL" />
          <Input value={block.alt || ''} onChange={(e) => onChange({ ...block, alt: e.target.value })} placeholder="Alt text" />
        </div>
      );
    case 'button':
      return (
        <div className="flex flex-col gap-2">
          <Input value={block.label || ''} onChange={(e) => onChange({ ...block, label: e.target.value })} placeholder="Button label" />
          <Input value={block.href || ''} onChange={(e) => onChange({ ...block, href: e.target.value })} placeholder="https://…" />
        </div>
      );
    case 'spacer':
      return <Input type="number" value={block.height || 24} onChange={(e) => onChange({ ...block, height: Number(e.target.value) })} className="w-24" />;
    default:
      return null;
  }
}

/** A structured block list editor (not a free-form drag-and-drop canvas — see docs/MARKETING_HUB_IMPLEMENTATION.md's Phase 3 entry for why that scope cut was made). `blocks`/`onChange` are the email_templates.blocks array. */
export default function EmailBlockEditor({ blocks, onChange }) {
  const update = (i, block) => onChange(blocks.map((b, idx) => (idx === i ? block : b)));
  const remove = (i) => onChange(blocks.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = (type) => onChange([...blocks, BLOCK_DEFS[type].create()]);

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        const def = BLOCK_DEFS[block.type];
        const Icon = def?.icon || Type;
        return (
          <div key={i} className="rounded-ui border border-hairline p-3 flex flex-col gap-2 bg-canvas">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted"><Icon size={14} /> {def?.label || block.type}</div>
              <div className="flex items-center gap-0.5">
                <IconButton icon={ChevronUp} label="Move up" size={14} onClick={() => move(i, -1)} disabled={i === 0} />
                <IconButton icon={ChevronDown} label="Move down" size={14} onClick={() => move(i, 1)} disabled={i === blocks.length - 1} />
                <IconButton icon={Trash2} label="Remove block" size={14} onClick={() => remove(i)} />
              </div>
            </div>
            <BlockFields block={block} onChange={(b) => update(i, b)} />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {Object.entries(BLOCK_DEFS).map(([type, def]) => (
          <Button key={type} size="sm" icon={Plus} onClick={() => add(type)}>{def.label}</Button>
        ))}
      </div>
    </div>
  );
}
