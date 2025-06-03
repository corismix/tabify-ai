const fs = require('fs');
const path = require('path');

const colors = {
  blue: '#4e71fe',
  red: '#e74c3c',
  yellow: '#f1c40f',
  green: '#2ecc71',
  purple: '#8e44ad',
  pink: '#ff7ab2',
  orange: '#e67e22',
  grey: '#95a5a6',
  cyan: '#1abc9c'
};

const templatesDir = path.join(__dirname, '../icons/folder-templates');
const outputDir = path.join(__dirname, '../icons/generated');
fs.mkdirSync(outputDir, { recursive: true });

const closedTemplate = fs.readFileSync(path.join(templatesDir, 'folder-closed-template.svg'), 'utf8');
const openTemplate = fs.readFileSync(path.join(templatesDir, 'folder-open-template.svg'), 'utf8');

function generateIcons(template, name) {
  Object.entries(colors).forEach(([colorName, hex]) => {
    const replaced = template.replace(/#3139FB/g, hex);
    const filePath = path.join(outputDir, `${name}-${colorName}.svg`);
    fs.writeFileSync(filePath, replaced, 'utf8');
  });
}

generateIcons(closedTemplate, 'folder-closed');
generateIcons(openTemplate, 'folder-open');
console.log('Generated icons for', Object.keys(colors).length, 'colors in', outputDir);
