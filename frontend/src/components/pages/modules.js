import React from 'react';
import { Link } from 'react-router-dom';
import Icon from '../icon';

const MODULES = [
  {
    path: '/task-groups',
    name: 'Target',
    icon: 'layers',
    description: 'Organize Target watch lists and account tasks into independently managed workspaces.',
  },
  {
    path: '/pokemoncenter',
    name: 'Pokémon Center',
    icon: 'ticket',
    description: 'Run profile-based US guest checkout tasks with queue handling and manual captcha solving.',
    taskType: 'pokemoncenter',
  },
];

export default function Modules({ taskTypes = {} }) {
  const availableModules = MODULES.filter(module => !module.taskType || taskTypes[module.taskType] === true);
  return (
    <>
      <div className="page-header">
        <div className="page-title"><span className="page-title-dot" /> Tasks</div>
      </div>
      <div className="page-content module-hub">
        <section className="module-hero">
          <span className="module-hero-mark"><Icon name="layers" size={22} /></span>
          <div>
            <h1>Choose a task workspace</h1>
            <p>Available workspaces are synced with your Zyn account.</p>
          </div>
        </section>
        <div className="module-grid">
          {availableModules.map(module => (
            <Link className="module-card" data-module={module.taskType || 'base'} to={module.path} key={module.path}>
              <span className="module-card-icon"><Icon name={module.icon} size={22} /></span>
              <span className="module-card-copy">
                <strong>{module.name}</strong>
                <small>{module.description}</small>
              </span>
              <span className="module-card-action">Open <Icon name="play" size={11} /></span>
            </Link>
          ))}
        </div>
        <div className="module-entitlement-note">Optional workspaces are managed by your Zyn account.</div>
      </div>
    </>
  );
}
