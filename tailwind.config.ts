import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./context/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Toss primary palette — true Toss blue, not default Tailwind blue
        toss: {
          50:  "#E8F3FF",
          100: "#C9E2FF",
          200: "#9DC8FF",
          500: "#3182F6", // primary
          600: "#1B64DA", // hover / pressed
          700: "#1957B9",
        },
        // Toss neutral palette — the grayscale Toss uses
        neutral: {
          25:  "#F9FAFB",
          50:  "#F2F4F6", // body background
          100: "#E5E8EB", // borders, dividers
          200: "#D1D6DB",
          400: "#8B95A1", // hint text
          500: "#6B7684", // secondary text
          700: "#4E5968", // body text
          900: "#191F28", // title / primary text
        },
        // Korean finance convention: red = gain, blue = loss
        gain: {
          50:  "#FEECEC",
          500: "#F04452",
          600: "#D43748",
        },
      },
      fontFamily: {
        sans: [
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Apple SD Gothic Neo",
          "Noto Sans KR",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      boxShadow: {
        // Toss's shadow is barely there — just enough to separate card from bg
        card: "0 1px 2px rgba(0, 0, 0, 0.04)",
        "card-hover": "0 4px 12px rgba(0, 0, 0, 0.06)",
        dropdown: "0 12px 32px rgba(0, 0, 0, 0.08)",
      },
      borderRadius: {
        // Toss uses a consistent 16px card radius
        toss: "16px",
        "toss-lg": "20px",
      },
      fontSize: {
        // Toss hero number size
        hero: ["36px", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "800" }],
      },
    },
  },
  plugins: [],
};

export default config;
