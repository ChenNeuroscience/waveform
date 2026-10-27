// Only the React hooks rules: they catch effects whose dependency lists drift
// from what the effect reads. Formatting is Prettier's job; types are tsc's.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config({
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "react-hooks": reactHooks },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  },
});
