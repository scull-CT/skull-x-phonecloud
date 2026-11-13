# PhoneCloud REST and realtime

Use the local gateway at `http://127.0.0.1:8766/db/DATABASE_ID` or a named HTTPS hostname mapped directly to the database. The API uses JSON documents and SSE. Firebase clients and Firebase rules are incompatible.

| Method and path | Operation |
| --- | --- |
| `POST /login` | Exchange `{"name":"alice","password":"…" }` for an expiring bearer token. An administrator provisions users. |
| `GET /records/tasks` | List documents. Supports `limit`, `offset`, `field`, `value` (JSON), `order` and `direction`. |
| `GET /records/tasks/RECORD_ID` | Fetch one document. |
| `POST /records/tasks` | Create a document from a JSON object. |
| `PUT /records/tasks/RECORD_ID` | Replace document data. |
| `DELETE /records/tasks/RECORD_ID` | Delete the document. |
| `GET /events/tasks` | Subscribe to `change` events with `{collection,type,record}`. Reconnect and fetch current state after interruption. |

Pass `Authorization: Bearer TOKEN` for protected operations. Private collections require database keys. User collections grant access to authenticated database users according to their read/write settings. Public reads require explicit collection configuration. Set the consuming site's HTTPS origin when creating the database if a browser will make cross-origin requests. SSE uses live delivery without replay.

## JavaScript

```js
const base = 'https://db.example.org';
const login = await fetch(base + '/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: username, password })
});
if (!login.ok) throw new Error('Sign-in failed');
const { token } = await login.json();
const headers = { Authorization: 'Bearer ' + token };
const response = await fetch(base + '/records/tasks', { headers });
if (!response.ok) throw new Error('Query failed');
console.log(await response.json());
const events = await fetch(base + '/events/tasks', { headers });
if (!events.ok) throw new Error('Subscription failed');
const reader = events.body.pipeThrough(new TextDecoderStream()).getReader();
let pending = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  pending += value;
  let end;
  while ((end = pending.indexOf('\n\n')) !== -1) {
    const message = pending.slice(0, end);
    pending = pending.slice(end + 2);
    const line = message.split('\n').find(line => line.startsWith('data: '));
    if (line) console.log(JSON.parse(line.slice(6)));
  }
}
```

## Android Kotlin

Run this in a background coroutine or executor with the Android INTERNET permission. Use a user session token for Android clients.

```kotlin
fun listTasks(base: String, token: String): String {
    val connection = java.net.URL("$base/records/tasks").openConnection()
        as javax.net.ssl.HttpsURLConnection
    connection.setRequestProperty("Authorization", "Bearer $token")
    connection.connectTimeout = 8000
    connection.readTimeout = 8000
    return try {
        check(connection.responseCode == 200)
        connection.inputStream.bufferedReader().use { it.readText() }
    } finally {
        connection.disconnect()
    }
}
```

## C# REST

```csharp
using System.Net.Http;
using System.Net.Http.Headers;

using var client = new HttpClient();
using var request = new HttpRequestMessage(HttpMethod.Get, baseUrl + "/records/tasks");
request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
using var response = await client.SendAsync(request);
response.EnsureSuccessStatusCode();
var documents = await response.Content.ReadAsStringAsync();
```
