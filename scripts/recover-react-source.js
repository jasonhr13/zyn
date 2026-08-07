'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'frontend', 'src');
const maps = [
  path.join(projectRoot, 'extracted', 'asar', 'build', 'static', 'js', 'main.ba6aa18f.chunk.js.map'),
  path.join(projectRoot, 'extracted', 'asar', 'build', 'static', 'css', 'main.14488fa5.chunk.css.map'),
];

let recovered = 0;
for (const mapPath of maps) {
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  map.sources.forEach((source, index) => {
    const content = map.sourcesContent && map.sourcesContent[index];
    if (content == null) throw new Error(`Source map content is missing for ${source}`);
    if (path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) {
      throw new Error(`Refusing unsafe source-map path: ${source}`);
    }
    const destination = path.join(sourceRoot, source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, 'utf8');
    recovered += 1;
  });
}

const indexPath = path.join(sourceRoot, 'index.js');
const originalIndex = fs.readFileSync(indexPath, 'utf8');
const react18Index = originalIndex
  .replace("import ReactDOM from 'react-dom';", "import { createRoot } from 'react-dom/client';")
  .replace(
    "ReactDOM.render(<App />, document.getElementById('root'));",
    "const root = createRoot(document.getElementById('root'));\nroot.render(<App />);",
  );
if (react18Index === originalIndex) {
  throw new Error('The recovered React entry point no longer matches the expected React 16 source');
}
fs.writeFileSync(indexPath, react18Index, 'utf8');

console.log(`Recovered ${recovered} React/CSS source files and applied the React 18 entry point in ${sourceRoot}`);
