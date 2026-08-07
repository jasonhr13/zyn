import React, { Component } from 'react';
import { Provider } from 'react-redux';
import Store from './components/store';
import PageHandler from './components/page-handler';
import './App.css';

class App extends Component {
  render() {
    return (
      <div className="App">
        <Provider store={Store}>
          <PageHandler />
        </Provider>
      </div>
    );
  }
}

export default App;
