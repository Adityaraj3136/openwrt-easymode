async function run() {
  const loginRes = await fetch('http://127.0.0.1:8787/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EasyMode': '1' },
    body: JSON.stringify({ host: 'demo', username: 'root', password: '' })
  });
  const loginData = await loginRes.json();
  const cookie = loginRes.headers.get('set-cookie');
  console.log('Login:', loginData);

  const res = await fetch('http://127.0.0.1:8787/api/wifi/radio/radio0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'X-EasyMode': '1' },
    body: JSON.stringify({ channel: 'auto' })
  });
  console.log('Optimize:', res.status, await res.text());
}
run();
