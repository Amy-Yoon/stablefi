"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { X, CheckCircle, AlertCircle, Info } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem { id: string; type: ToastType; message: string; }
interface ToastContextValue { toast: (message: string, type?: ToastType) => void; }

const ToastContext = createContext<ToastContextValue | null>(null);

// Inline colors — same reasoning as the swap CTA: Tailwind JIT/HMR sometimes
// drops dynamic classes, and an invisible toast is worse than a styled one.
const TOAST_STYLE: Record<ToastType, React.CSSProperties> = {
  success: { backgroundColor: "#191F28", color: "#FFFFFF" },
  error:   { backgroundColor: "#F04452", color: "#FFFFFF" },
  info:    { backgroundColor: "#191F28", color: "#FFFFFF" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const remove = (id: string) => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed left-4 right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] sm:left-auto sm:right-6 sm:bottom-6 z-50 flex flex-col gap-2 pointer-events-none">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            style={TOAST_STYLE[item.type]}
            className="flex items-start gap-2.5 px-4 py-3 rounded-toss shadow-dropdown text-[13px] font-bold pointer-events-auto animate-in max-w-md"
          >
            <span style={{ color: "#FFFFFF", flexShrink: 0, marginTop: 1 }}>
              {item.type === "success" && <CheckCircle size={15} />}
              {item.type === "error"   && <AlertCircle  size={15} />}
              {item.type === "info"    && <Info         size={15} />}
            </span>
            <span style={{ color: "#FFFFFF", flex: 1, lineHeight: 1.5, wordBreak: "break-word" }}>
              {item.message}
            </span>
            <button
              onClick={() => remove(item.id)}
              style={{ color: "rgba(255,255,255,0.7)", flexShrink: 0, marginTop: 1 }}
              aria-label="닫기"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be inside ToastProvider");
  return ctx;
}
