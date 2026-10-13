import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

interface MenuContextValue {
  register: (el: HTMLButtonElement | null, id: string) => void;
  focusByOffset: (fromId: string, delta: number) => void;
  focusEdge: (edge: "first" | "last") => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuListProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  children?: ReactNode;
  "aria-label"?: string;
}

export function MenuList({ children, className, onKeyDown, ...rest }: MenuListProps) {
  const itemsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const orderRef = useRef<string[]>([]);

  const register = useCallback((el: HTMLButtonElement | null, id: string) => {
    if (el) {
      itemsRef.current.set(id, el);
      if (!orderRef.current.includes(id)) orderRef.current.push(id);
    } else {
      itemsRef.current.delete(id);
      orderRef.current = orderRef.current.filter((x) => x !== id);
    }
  }, []);

  const focusByOffset = useCallback((fromId: string, delta: number) => {
    const order = orderRef.current.filter((id) => {
      const el = itemsRef.current.get(id);
      return el && !el.disabled;
    });
    const i = order.indexOf(fromId);
    if (i < 0 || order.length === 0) return;
    const next = order[(i + delta + order.length * 10) % order.length]!;
    itemsRef.current.get(next)?.focus();
  }, []);

  const focusEdge = useCallback((edge: "first" | "last") => {
    const order = orderRef.current.filter((id) => {
      const el = itemsRef.current.get(id);
      return el && !el.disabled;
    });
    if (order.length === 0) return;
    const id = edge === "first" ? order[0]! : order[order.length - 1]!;
    itemsRef.current.get(id)?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    switch (e.key) {
      case "Home":
        e.preventDefault();
        focusEdge("first");
        break;
      case "End":
        e.preventDefault();
        focusEdge("last");
        break;
      default:
        break;
    }
  }

  const cls = ["rb-menu", className ?? ""].filter(Boolean).join(" ");

  return (
    <MenuContext.Provider value={{ register, focusByOffset, focusEdge }}>
      <div role="menu" className={cls} onKeyDown={handleKeyDown} {...rest}>
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps extends Omit<HTMLAttributes<HTMLButtonElement>, "role"> {
  danger?: boolean;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  children?: ReactNode;
  onSelect?: () => void;
}

export function MenuItem({
  danger = false,
  icon,
  hint,
  disabled = false,
  children,
  className,
  onClick,
  onKeyDown,
  onSelect,
  ...rest
}: MenuItemProps) {
  const ctx = useContext(MenuContext);
  const reactId = useId();
  const ref = useRef<HTMLButtonElement>(null);

  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      ref.current = el;
      ctx?.register(el, reactId);
    },
    [ctx, reactId],
  );

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented || !ctx) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        ctx.focusByOffset(reactId, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        ctx.focusByOffset(reactId, -1);
        break;
      case "Home":
        e.preventDefault();
        ctx.focusEdge("first");
        break;
      case "End":
        e.preventDefault();
        ctx.focusEdge("last");
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!disabled) ref.current?.click();
        break;
      default:
        break;
    }
  }

  const cls = ["rb-menu__item", danger ? "rb-menu__item--danger" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={setRef}
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cls}
      onClick={(e) => {
        onSelect?.();
        onClick?.(e);
      }}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {icon ? <span className="rb-menu__icon">{icon}</span> : null}
      <span className="rb-menu__label">{children}</span>
      {hint ? <span className="rb-menu__hint">{hint}</span> : null}
    </button>
  );
}
