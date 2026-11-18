import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/noto-sans-sc';
import './styles.css';
import './polish.css';
import { Workspace } from './Workspace';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Workspace /></React.StrictMode>);
