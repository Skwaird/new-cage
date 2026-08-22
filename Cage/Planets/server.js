const express = require('express');
const cors = require('cors');
const path = require('path');
const { runProxy } = require('./lib/proxy-core');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/proxy/:target', runProxy);
app.post('/proxy/:target', runProxy);
app.get('/proxy', runProxy);
app.post('/proxy', runProxy);

app.listen(PORT, () => {
  console.log(`💎 Crystal proxy running at http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT}/Planet-Crystal.html`);
});