import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';

export interface PresetSelectOption {
  value: string;
  label?: string;
  badge?: string;
}

type RawOption = string | PresetSelectOption;

function normalizeOption(opt: RawOption): { value: string; label: string; badge?: string } {
  if (typeof opt === 'string') {
    return { value: opt, label: opt };
  }
  return {
    value: opt.value,
    label: opt.label || opt.value,
    badge: opt.badge,
  };
}

interface PopoverCoords {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

function computePopoverCoords(el: HTMLElement, minHeight = 250): PopoverCoords {
  const rect = el.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUpward = spaceBelow < minHeight && spaceAbove > spaceBelow;
  const clampedWidth = Math.max(180, Math.min(rect.width, window.innerWidth - 16));
  const clampedLeft = Math.max(8, Math.min(rect.left, window.innerWidth - clampedWidth - 8));

  if (openUpward) {
    return {
      left: clampedLeft,
      width: clampedWidth,
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    };
  }
  return {
    left: clampedLeft,
    width: clampedWidth,
    top: Math.min(window.innerHeight - 60, rect.bottom + 4),
  };
}

interface PresetSingleSelectProps {
  value: string;
  options: RawOption[];
  onChange: (nextValue: string) => void;
  onAddPreset?: (newValue: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  size?: 'sm' | 'xs';
  allowClear?: boolean;
  className?: string;
}

export const PresetSingleSelect: React.FC<PresetSingleSelectProps> = ({
  value,
  options,
  onChange,
  onAddPreset,
  placeholder = 'Auswählen…',
  searchPlaceholder = 'Suchen oder eigenen Wert eingeben…',
  size = 'sm',
  allowClear = false,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const normalized = useMemo(() => options.map(normalizeOption), [options]);

  const activeOption = useMemo(
    () => normalized.find((o) => o.value.toLowerCase() === value.trim().toLowerCase()) || null,
    [normalized, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return normalized;
    return normalized.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q) ||
        (opt.badge && opt.badge.toLowerCase().includes(q))
    );
  }, [normalized, query]);

  const trimmedQuery = query.trim();
  const hasExactMatch = useMemo(() => {
    if (!trimmedQuery) return true;
    const low = trimmedQuery.toLowerCase();
    return normalized.some(
      (opt) => opt.value.toLowerCase() === low || opt.label.toLowerCase() === low
    );
  }, [normalized, trimmedQuery]);

  const isCurrentCustom = Boolean(value.trim()) && !activeOption;

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      setCoords(computePopoverCoords(triggerRef.current, 240));
    }
  }, []);

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && triggerRef.current) {
        setCoords(computePopoverCoords(triggerRef.current, 240));
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        (!menuRef.current || !menuRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onScrollOrResize = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      updatePosition();
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updatePosition]);

  const handleSelect = (nextVal: string) => {
    onChange(nextVal);
    setOpen(false);
    setQuery('');
  };

  const handleSelectAndSavePreset = (newVal: string) => {
    const clean = newVal.trim();
    if (!clean) return;
    onAddPreset?.(clean);
    onChange(clean);
    setOpen(false);
    setQuery('');
  };

  const triggerPadding = size === 'xs' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs';
  const triggerBg = size === 'xs' ? 'bg-[#1b2129]' : 'bg-[#13171c]';

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={toggleOpen}
        className={`w-full flex items-center justify-between gap-1.5 rounded border text-left transition-colors ${triggerPadding} ${triggerBg} ${
          open
            ? 'border-[#4ea1d3] text-white'
            : 'border-[#2c3542] text-[#e4ecf5] hover:border-[#3e4b5d]'
        }`}
      >
        <span className="flex items-center gap-1.5 min-w-0 truncate">
          {activeOption?.badge && (
            <span className="px-1 py-0 rounded bg-[#233244] border border-[#354c66] font-mono text-[10px] text-[#8fd0f8] shrink-0">
              {activeOption.badge}
            </span>
          )}
          <span className={`truncate ${value ? 'text-[#e4ecf5]' : 'text-[#6c7788]'}`}>
            {activeOption?.label || value || placeholder}
          </span>
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          {allowClear && value && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              className="p-0.5 rounded text-[#7f8c9d] hover:text-white hover:bg-[#2a323e]"
              title="Leeren"
            >
              <X className="w-3 h-3" />
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-[#7f8c9d] transition-transform ${
              open ? 'rotate-180 text-[#7cc4f0]' : ''
            }`}
          />
        </span>
      </button>

      {open && coords && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: coords.left,
            width: coords.width,
            top: coords.top,
            bottom: coords.bottom,
          }}
          className="z-[90] rounded-md bg-[#181d24] border border-[#344050] shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Search / Custom Input */}
          <div className="p-1.5 border-b border-[#262e39] bg-[#14181e]">
            <div className="relative flex items-center">
              <Search className="w-3 h-3 text-[#6f7b8b] absolute left-2 pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (filtered.length > 0 && (hasExactMatch || !trimmedQuery)) {
                      handleSelect(filtered[0].value);
                    } else if (trimmedQuery) {
                      handleSelect(trimmedQuery);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                className="w-full pl-6 pr-6 py-1 rounded bg-[#101419] border border-[#2a323e] text-[11px] text-[#e4ecf5] placeholder:text-[#636f80] focus:outline-none focus:border-[#4ea1d3]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 text-[#7c8899] hover:text-white"
                  tabIndex={-1}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Current non-preset custom value banner */}
          {isCurrentCustom && !trimmedQuery && (
            <div className="px-2 py-1.5 bg-[#1d2530] border-b border-[#293444] flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-[#bcd6ee]" title={value}>
                Aktuell: <strong className="text-white">{value}</strong>
              </span>
              {onAddPreset && (
                <button
                  type="button"
                  onClick={() => handleSelectAndSavePreset(value)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#274059] hover:bg-[#315170] text-[#bce2ff] text-[10px] font-medium whitespace-nowrap shrink-0"
                >
                  <Plus className="w-2.5 h-2.5" />
                  Als Preset
                </button>
              )}
            </div>
          )}

          {/* Options List */}
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((opt) => {
              const selected = opt.value.toLowerCase() === value.trim().toLowerCase();
              return (
                <button
                  key={`${opt.value}-${opt.badge || ''}`}
                  type="button"
                  onClick={() => handleSelect(opt.value)}
                  className={`w-full px-2.5 py-1.5 text-left flex items-center justify-between gap-2 text-[11.5px] transition-colors ${
                    selected
                      ? 'bg-[#253a4f] text-white font-medium'
                      : 'text-[#cfd8e4] hover:bg-[#222933] hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0 truncate">
                    {opt.badge && (
                      <span className="px-1.5 py-0 rounded bg-[#141a22] border border-[#2f3c4c] font-mono text-[10px] text-[#7ec7f5] shrink-0">
                        {opt.badge}
                      </span>
                    )}
                    <span className="truncate">{opt.label}</span>
                  </span>
                  {selected && <Check className="w-3.5 h-3.5 text-[#5eb1e6] shrink-0" />}
                </button>
              );
            })}

            {filtered.length === 0 && !trimmedQuery && (
              <div className="px-3 py-2 text-[11px] text-[#748091]">Keine Einträge vorhanden.</div>
            )}
          </div>

          {/* Custom value actions when typing something not in list */}
          {trimmedQuery && !hasExactMatch && (
            <div className="p-1.5 border-t border-[#262e39] bg-[#14181e] space-y-1">
              <button
                type="button"
                onClick={() => handleSelect(trimmedQuery)}
                className="w-full px-2 py-1 rounded text-left text-[11px] bg-[#202935] hover:bg-[#2a3646] text-[#dce8f5] transition-colors truncate"
              >
                „<strong className="text-white">{trimmedQuery}</strong>“ einmalig verwenden
              </button>
              {onAddPreset && (
                <button
                  type="button"
                  onClick={() => handleSelectAndSavePreset(trimmedQuery)}
                  className="w-full px-2 py-1 rounded text-left text-[11px] bg-[#213a4f] hover:bg-[#2a4b66] border border-[#4ea1d3]/50 text-[#d8f0ff] flex items-center gap-1 transition-colors truncate"
                >
                  <Plus className="w-3 h-3 text-[#7cc4f0] shrink-0" />
                  <span className="truncate">
                    „<strong>{trimmedQuery}</strong>“ verwenden &amp; als Preset speichern
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface PresetMultiSelectProps {
  values: string[];
  options: string[];
  onChange: (nextValues: string[]) => void;
  onAddPreset?: (newValue: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  chipTone?: 'sky' | 'violet' | 'emerald';
  className?: string;
}

export const PresetMultiSelect: React.FC<PresetMultiSelectProps> = ({
  values,
  options,
  onChange,
  onAddPreset,
  placeholder = 'Auswählen…',
  searchPlaceholder = 'Filtern oder eigenen Tag eingeben…',
  chipTone = 'sky',
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedLower = useMemo(
    () => new Set(values.map((v) => v.trim().toLowerCase())),
    [values]
  );

  // Combine preset options + any custom selected values not yet in options
  const allOptions = useMemo(() => {
    const seen = new Set(options.map((o) => o.toLowerCase()));
    const extras = values.filter((v) => v.trim() && !seen.has(v.trim().toLowerCase()));
    return [...extras, ...options];
  }, [options, values]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((opt) => opt.toLowerCase().includes(q));
  }, [allOptions, query]);

  const trimmedQuery = query.trim();
  const hasExactMatch = useMemo(() => {
    if (!trimmedQuery) return true;
    const low = trimmedQuery.toLowerCase();
    return allOptions.some((o) => o.toLowerCase() === low);
  }, [allOptions, trimmedQuery]);

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      setCoords(computePopoverCoords(triggerRef.current, 250));
    }
  }, []);

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && triggerRef.current) {
        setCoords(computePopoverCoords(triggerRef.current, 250));
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        (!menuRef.current || !menuRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onScrollOrResize = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      updatePosition();
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updatePosition]);

  // Reposition popover when selected tags wrap to a new line
  useEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, values.length, updatePosition]);

  const toggleValue = (val: string) => {
    const low = val.trim().toLowerCase();
    if (selectedLower.has(low)) {
      onChange(values.filter((v) => v.trim().toLowerCase() !== low));
    } else {
      onChange([...values, val.trim()]);
    }
  };

  const addCustomTags = (raw: string, saveAsPreset: boolean) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;

    const next = [...values];
    const existing = new Set(next.map((v) => v.toLowerCase()));
    for (const part of parts) {
      if (!existing.has(part.toLowerCase())) {
        next.push(part);
        existing.add(part.toLowerCase());
      }
      if (saveAsPreset) {
        onAddPreset?.(part);
      }
    }
    onChange(next);
    setQuery('');
  };

  const chipClasses =
    chipTone === 'violet'
      ? 'bg-violet-500/20 border-violet-500/45 text-violet-100'
      : chipTone === 'emerald'
      ? 'bg-emerald-500/20 border-emerald-500/45 text-emerald-100'
      : 'bg-[#21384c] border-[#4ea1d3]/50 text-[#d7eeff]';

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      {/* Trigger box displaying selected tags */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleOpen();
          }
        }}
        className={`w-full min-h-[30px] px-2 py-1 rounded bg-[#13171c] border transition-colors cursor-pointer flex items-center justify-between gap-1.5 ${
          open ? 'border-[#4ea1d3]' : 'border-[#2c3542] hover:border-[#3e4b5d]'
        }`}
      >
        <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
          {values.length === 0 ? (
            <span className="text-xs text-[#6c7788] px-0.5">{placeholder}</span>
          ) : (
            values.map((tag) => (
              <span
                key={tag}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium leading-tight max-w-full ${chipClasses}`}
              >
                <span className="truncate">{tag}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleValue(tag);
                  }}
                  className="opacity-75 hover:opacity-100 hover:text-white shrink-0"
                  title={`${tag} entfernen`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[#7f8c9d] shrink-0 transition-transform ${
            open ? 'rotate-180 text-[#7cc4f0]' : ''
          }`}
        />
      </div>

      {open && coords && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: coords.left,
            width: coords.width,
            top: coords.top,
            bottom: coords.bottom,
          }}
          className="z-[90] rounded-md bg-[#181d24] border border-[#344050] shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Search + clear header */}
          <div className="p-1.5 border-b border-[#262e39] bg-[#14181e] space-y-1.5">
            <div className="relative flex items-center">
              <Search className="w-3 h-3 text-[#6f7b8b] absolute left-2 pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!trimmedQuery) return;
                    const exact = allOptions.find(
                      (o) => o.toLowerCase() === trimmedQuery.toLowerCase()
                    );
                    if (exact) {
                      toggleValue(exact);
                      setQuery('');
                    } else {
                      addCustomTags(trimmedQuery, false);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                className="w-full pl-6 pr-6 py-1 rounded bg-[#101419] border border-[#2a323e] text-[11px] text-[#e4ecf5] placeholder:text-[#636f80] focus:outline-none focus:border-[#4ea1d3]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 text-[#7c8899] hover:text-white"
                  tabIndex={-1}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {values.length > 0 && (
              <div className="flex items-center justify-between px-0.5 text-[10.5px] text-[#7f8c9d]">
                <span>{values.length} ausgewählt</span>
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-rose-300/90 hover:text-rose-200 hover:underline"
                >
                  Alle entfernen
                </button>
              </div>
            )}
          </div>

          {/* Multi-select options */}
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((opt) => {
              const checked = selectedLower.has(opt.toLowerCase());
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggleValue(opt)}
                  className={`w-full px-2.5 py-1.5 text-left flex items-center justify-between gap-2 text-[11.5px] transition-colors ${
                    checked
                      ? 'bg-[#23374b] text-white font-medium'
                      : 'text-[#cfd8e4] hover:bg-[#222933] hover:text-white'
                  }`}
                >
                  <span className="truncate">{opt}</span>
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      checked
                        ? 'bg-[#3675a3] border-[#5eb1e6] text-white'
                        : 'bg-[#12161c] border-[#344050] text-transparent'
                    }`}
                  >
                    <Check className="w-3 h-3" />
                  </span>
                </button>
              );
            })}

            {filtered.length === 0 && !trimmedQuery && (
              <div className="px-3 py-2 text-[11px] text-[#748091]">Keine Einträge vorhanden.</div>
            )}
          </div>

          {/* Custom tag actions */}
          {trimmedQuery && !hasExactMatch && (
            <div className="p-1.5 border-t border-[#262e39] bg-[#14181e] space-y-1">
              <button
                type="button"
                onClick={() => addCustomTags(trimmedQuery, false)}
                className="w-full px-2 py-1 rounded text-left text-[11px] bg-[#202935] hover:bg-[#2a3646] text-[#dce8f5] transition-colors truncate"
              >
                + „<strong className="text-white">{trimmedQuery}</strong>“ einmalig hinzufügen
              </button>
              {onAddPreset && (
                <button
                  type="button"
                  onClick={() => addCustomTags(trimmedQuery, true)}
                  className="w-full px-2 py-1 rounded text-left text-[11px] bg-[#213a4f] hover:bg-[#2a4b66] border border-[#4ea1d3]/50 text-[#d8f0ff] flex items-center gap-1 transition-colors truncate"
                >
                  <Plus className="w-3 h-3 text-[#7cc4f0] shrink-0" />
                  <span className="truncate">
                    „<strong>{trimmedQuery}</strong>“ hinzufügen &amp; als Preset speichern
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
