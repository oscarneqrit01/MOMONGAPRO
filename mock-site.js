const express = require('express');

const app = express();
const port = Number(process.env.MOCK_PORT || 4100);
const scenario = String(process.env.MOCK_SCENARIO || 'normal').trim().toLowerCase();
let bumpCount = 0;
let repostCount = 0;
let bumpedIds = [];

app.use(express.urlencoded({ extended: false }));

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.5">
  <h1>MegaPersonals local test site</h1>
  ${body}
</body>
</html>`;

app.get('/', (request, response) => {
  if (scenario === 'session-closed') {
    return response.send(layout('Login', '<h2>Session expired</h2><form><input type="email"><input type="password"><button>Login</button></form>'));
  }
  return response.redirect('/users/posts/list');
});

app.get('/users/posts/list', (request, response) => {
  if (scenario === 'blocked') {
    return response.send(layout('My Posts', `
      <h2>Your account has been suspended</h2>
      <p class="error">This account is blocked and cannot publish.</p>
    `));
  }

  if (scenario === 'multi-ads') {
    const adCount = Math.max(1, Number(process.env.MOCK_ADS || 3));
    const ads = Array.from({ length: adCount }, (_, index) => 52957356 + index).map((id, index) => `
      <div class="post_header">
        <div class="post_title"><div class="post_title_caption">Anuncio ${index + 1}</div></div>
        <a href="/users/posts/bump/${id}">Bump to Top</a>
      </div>`).join('');
    return response.send(layout('My Posts', `
      <h2>My Posts</h2>
      ${ads}
      <p>Bumps confirmed: <strong>${bumpCount}</strong> | IDs: <strong>${bumpedIds.join(',')}</strong></p>
    `));
  }

  response.send(layout('My Posts', `
    <h2>My Posts</h2>
    <p id="post-status">Test ad is published.</p>
    <button id="managePublishAd" onclick="window.location.href='/users/posts/success_publish/${Date.now()}'">Bump to Top</button>
    ${scenario === 'deleted' ? '' : '<a href="/users/posts/delete-confirm">Delete</a>'}
    <p>Bumps confirmed: <strong>${bumpCount}</strong> | Reposts confirmed: <strong>${repostCount}</strong></p>
  `));
});

app.get('/users/posts/bump/:id', (request, response) => {
  response.redirect(`/users/posts/success_publish/${request.params.id}`);
});

app.get('/users/posts/success_publish/:id', (request, response) => {
  bumpCount += 1;
  if (/^\d+$/.test(request.params.id)) bumpedIds.push(request.params.id);
  response.send(layout('Post published', `
    <h2>Sweet!</h2>
    <p>Your Post has been published!</p>
    <a href="/users/posts/list">VIEW POST</a>
    <a href="/users/posts/list">MY POSTS</a>
  `));
});

app.get('/users/posts/delete-confirm', (request, response) => {
  response.send(layout('Confirm delete', `
    <h2>Delete post</h2>
    <button onclick="window.location.href='/users/posts/list'">Confirm delete</button>
  `));
});

app.get('/users/posts/create', (request, response) => {
  const publishTarget = scenario === 'publish-error'
    ? '/users/posts/error-message'
    : `/users/posts/success_publish/repost-${Date.now()}`;
  const cityOptions = scenario === 'missing-city'
    ? '<option>--- Select City ---</option><option>Montreal</option>'
    : '<option>--- Select City ---</option><option>Charleston, SC</option><option>Montreal</option>';
  const photoInput = scenario === 'missing-photos' ? '' : '<label>Photos <input type="file" multiple></label>';
  const captchaInput = scenario === 'captcha-pending' ? '<label>Captcha <input name="captcha" placeholder="Enter code from the picture"></label>' : '';
  response.send(layout('Create post', `
    <h2>Create post</h2>
    <form id="post-form" onsubmit="event.preventDefault();window.location.href='${publishTarget}'">
      <div id="step-one">
        <label>Name <input name="name"></label>
        <label>Headline <input name="headline"></label>
        <label>Age <input name="age"></label>
        <label>Body <textarea name="body"></textarea></label>
        <label>City <select name="city">${cityOptions}</select></label>
        <label>Location <input name="location"></label>
        <label>Phone <input type="tel" name="phone"></label>
        <button type="button" id="next-step" onclick="document.getElementById('step-one').hidden=true;document.getElementById('step-two').hidden=false">Next</button>
      </div>
      <div id="step-two" hidden>
        ${photoInput}
        ${captchaInput}
        <button type="submit">Publish</button>
      </div>
    </form>
  `));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Local test site: http://127.0.0.1:${port}`);
});
