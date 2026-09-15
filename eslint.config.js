import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
export default [{files:['src/**/*.{ts,tsx}','api/**/*.ts'],languageOptions:{parser,parserOptions:{ecmaVersion:'latest',sourceType:'module'}},plugins:{'@typescript-eslint':tseslint},rules:{'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':'off'}}];
