// React hooks rules (effects whose dependency lists drift from what they read)
// plus two readability rules: braces on every if/else/loop, and one variable per
// declaration. Formatting is Prettier's job; types are tsc's.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config({
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "react-hooks": reactHooks },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    curly: ["error", "all"],
    "one-var": ["error", "never"],
  },
});
