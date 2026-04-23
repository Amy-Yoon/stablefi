// StableFi brand mark — a rounded-square Toss-blue badge with a bold
// white "S" letter inside. Uses inline styles (not Tailwind classes)
// so it renders correctly regardless of Tailwind JIT caching state.

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-label="StableFi"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        backgroundColor: "#3182F6",
        borderRadius: Math.round(size * 0.28),
        color: "#FFFFFF",
        fontWeight: 900,
        fontSize: size * 0.6,
        lineHeight: 1,
        letterSpacing: "-0.04em",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      S
    </span>
  );
}
