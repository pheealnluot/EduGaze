fetch('http://localhost:8080/api/quiz-generate', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    contents: [{role:'user', parts:[{text:'Say hello'}]}],
    generationConfig: {temperature:0.1, maxOutputTokens:50}
  })
}).then(r => { console.log('STATUS:', r.status); return r.text(); })
  .then(t => console.log('BODY:', t.slice(0,400)))
  .catch(e => console.error('ERROR:', e.message));
