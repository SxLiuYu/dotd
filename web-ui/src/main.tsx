import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const el = document.getElementById('root');
if (el === null) throw new Error('#root 缺失：index.html 被改过？');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
