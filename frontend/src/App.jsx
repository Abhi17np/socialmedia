import React, { useState, useCallback } from 'react';
import './App.css';
import Login from './auth/Login';
import Signup from './auth/Signup';
import SocialNav from './social/SocialNav';
import Dashboard from './social/Dashboard';
import Composer from './social/Composer';
import Posts from './social/Posts';
import Inbox from './social/Inbox';
import Analytics from './social/Analytics';
import ConnectAccounts from './social/ConnectAccounts';

const VIEWS = {
  dashboard: Dashboard,
  composer: Composer,
  posts: Posts,
  inbox: Inbox,
  analytics: Analytics,
  connect: ConnectAccounts
};

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [authScreen, setAuthScreen] = useState('login'); // 'login' | 'signup'
  const [currentView, setCurrentView] = useState('dashboard');

  const handleLoggedIn = (newToken) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
  };

  // Every component below calls the API through this, never a bare
  // fetch — it attaches the Bearer token and logs out on a 401 instead
  // of each component having to handle an expired/invalid token itself.
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = { ...options.headers, Authorization: `Bearer ${token}` };
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) handleLogout();
    return res;
  }, [token]);

  if (!token) {
    return authScreen === 'login'
      ? <Login onLoggedIn={handleLoggedIn} onSwitchToSignup={() => setAuthScreen('signup')} />
      : <Signup onLoggedIn={handleLoggedIn} onSwitchToLogin={() => setAuthScreen('login')} />;
  }

  const CurrentViewComponent = VIEWS[currentView] || Dashboard;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SocialNav currentView={currentView} setCurrentView={setCurrentView} />
        <button className="logout-link" onClick={handleLogout}>Log out</button>
      </aside>
      <main className="app-main">
        <CurrentViewComponent authFetch={authFetch} setCurrentView={setCurrentView} />
      </main>
    </div>
  );
}
