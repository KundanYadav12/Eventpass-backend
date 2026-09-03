const fs = require('fs');
const path = require('path');

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach(function(file) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else if (file.endsWith('.js')) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

const allJsFiles = getAllFiles(path.resolve(__dirname, 'src'));
console.log('Total JS files checked:', allJsFiles.length);

let errors = [];
let thirdPartyPackages = new Set();

allJsFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const regex = /require\(['"]([^'"]+)['"]\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const reqPath = match[1];
    if (reqPath.startsWith('.')) {
      const candidate = path.resolve(dir, reqPath);
      let resolved = null;
      if (fs.existsSync(candidate + '.js')) resolved = candidate + '.js';
      else if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, 'index.js'))) resolved = path.join(candidate, 'index.js');
      else if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) resolved = candidate;

      if (!resolved) {
        errors.push({ file, reqPath, error: 'Module does not exist' });
      } else {
        // Check exact case of each path segment on disk
        const rel = path.relative(path.resolve(__dirname), resolved);
        const parts = rel.split(path.sep);
        let current = path.resolve(__dirname);
        for (const part of parts) {
          const entries = fs.readdirSync(current);
          if (!entries.includes(part)) {
            errors.push({
              file: path.relative(__dirname, file),
              reqPath,
              error: `Case mismatch! Expected "${part}", found "${entries.find(e => e.toLowerCase() === part.toLowerCase())}"`
            });
            break;
          }
          current = path.join(current, part);
        }
      }
    } else {
      // Third-party or built-in
      const builtIns = ['fs', 'path', 'crypto', 'os', 'child_process', 'util', 'http', 'https', 'stream', 'events', 'url', 'buffer', 'net', 'tls', 'dns', 'zlib'];
      const basePkg = reqPath.split('/')[0];
      if (!builtIns.includes(basePkg)) {
        thirdPartyPackages.add(basePkg);
      }
    }
  }
});

console.log('\n--- Third Party Packages Required ---');
console.log(Array.from(thirdPartyPackages));

const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
const declaredDeps = Object.keys(pkgJson.dependencies || {});
const missingDeps = Array.from(thirdPartyPackages).filter(p => !declaredDeps.includes(p));

console.log('\n--- Missing from package.json dependencies ---');
console.log(missingDeps);

console.log('\n--- Path / Case Sensitivity Errors ---');
console.log(errors);
