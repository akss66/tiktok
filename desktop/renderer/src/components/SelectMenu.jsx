import { Children, Fragment, isValidElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

function toOptions(children) {
  return Children.toArray(children)
    .filter((child) => isValidElement(child) && child.type === 'option')
    .map((child) => ({
      value: String(child.props.value ?? ''),
      label: child.props.children,
      disabled: Boolean(child.props.disabled),
    }));
}

export function SelectMenu({
  value,
  defaultValue = '',
  onChange,
  children,
  className = '',
  disabled = false,
  'aria-label': ariaLabel,
}) {
  const options = useMemo(() => toOptions(children), [children]);
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(String(defaultValue ?? ''));
  const selectedValue = String(controlled ? value ?? '' : internalValue);
  const selectedOption = options.find((option) => option.value === selectedValue) || options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [menuStyle, setMenuStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const listboxId = useId();

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openMenu() {
    if (disabled || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = Math.min(280, options.length * 38 + 8);
    const opensUpward = window.innerHeight - rect.bottom < estimatedHeight + 12 && rect.top > estimatedHeight;
    const menuWidth = Math.max(160, rect.width);
    setMenuStyle({
      left: Math.min(rect.left, window.innerWidth - menuWidth - 8),
      top: opensUpward ? Math.max(8, rect.top - estimatedHeight - 4) : rect.bottom + 4,
      width: menuWidth,
      maxHeight: Math.min(280, opensUpward ? rect.top - 12 : window.innerHeight - rect.bottom - 12),
    });
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function choose(option) {
    if (!option || option.disabled) return;
    const target = { value: option.value };
    onChange?.({ target, currentTarget: target });
    if (!controlled) setInternalValue(String(target.value ?? ''));
    closeMenu({ restoreFocus: true });
  }

  function moveActive(direction) {
    if (!options.length) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActiveIndex(next);
  }

  function handleKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(options[activeIndex]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
    }
    if (event.key === 'Tab') closeMenu();
  }

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    const handleViewportChange = (event) => {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open]);

  return (
    <div className={`select-menu${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className={!selectedValue ? 'select-menu-placeholder' : ''}>{selectedOption?.label ?? ''}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && menuStyle ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="select-menu-popover"
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
          onKeyDown={handleKeyDown}
        >
          {options.map((option, index) => {
            const isCommittedSelection = option.value && option.value === selectedValue;
            const optionClasses = [
              index === activeIndex ? 'active' : '',
              isCommittedSelection ? 'selected' : '',
              option.value ? '' : 'placeholder-option',
            ].filter(Boolean).join(' ');

            return (
              <Fragment key={`${option.value}-${index}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={Boolean(isCommittedSelection)}
                  className={optionClasses}
                  disabled={option.disabled}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {isCommittedSelection ? <Check size={15} strokeWidth={2.2} aria-hidden="true" /> : null}
                </button>
                {!option.value && index < options.length - 1 ? (
                  <div className="select-menu-separator" role="separator" />
                ) : null}
              </Fragment>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
