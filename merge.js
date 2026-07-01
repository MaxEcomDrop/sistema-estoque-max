const fs = require('fs');
const htmlTop = fs.readFileSync('new_html.html', 'utf8');
const jsCode = fs.readFileSync('extracted_js.txt', 'utf8');
const finalHtml = htmlTop + '\n' + jsCode + '\n</script>\n</body>\n</html>';
fs.writeFileSync('public/dashboard.html', finalHtml);
console.log('Merged successfully!');
