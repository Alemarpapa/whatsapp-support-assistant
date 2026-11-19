# 💬 WhatsApp Support Assistant — el bot responde, una persona toma el control

*Versión en español de [README.md](README.md), para revisión del autor. El texto oficial es el inglés.*

Un servidor webhook para la WhatsApp Business Cloud API. Responde preguntas simples (horarios, ubicación) y pasa el chat a una persona cuando el cliente lo pide, cuando no entiende dos mensajes seguidos, o cuando una persona responde desde la app WhatsApp Business. Después del traspaso el bot se queda callado en ese chat hasta que un operador lo libera.

> **Alcance, con honestidad:** es un proyecto de portafolio. **Nunca se conectó a una cuenta real de Meta.** Todo se probó con tests unitarios y un simulador local que envía pedidos firmados con la forma de los payloads de las guías de Meta. La detección de intención es por palabras clave, no un LLM.

## Qué hace

| Capacidad | Comportamiento |
|-----------|----------------|
| **Verificación del webhook (GET)** | Devuelve `hub.challenge` solo si `hub.verify_token` coincide; si no, 403. |
| **Chequeo de firma (POST)** | HMAC SHA-256 del cuerpo crudo con el app secret, comparado en tiempo constante, antes de parsear nada. Firma mala o ausente: 401. Cuerpos de más de 3 MB: 413. |
| **Idempotencia** | Cada id de mensaje se reserva en SQLite antes de procesarlo. Un id reenviado no recibe segunda respuesta, tampoco después de reiniciar. |
| **Fallas de envío** | Si la respuesta no se puede enviar, se libera la reserva y el servidor responde 500, así el reintento se procesa de nuevo. |
| **Traspaso a una persona** | El bot deja de responder en esa conversación. Las demás no se ven afectadas. `npm run admin -- release <wa_id>` devuelve el chat al bot. |
| **Carrera en el traspaso** | Si una persona toma el control mientras una respuesta del bot todavía se está enviando, el guardado del bot no puede pisar el modo `human` (una sola sentencia SQL condicional; cubierto por tests). |
| **Privacidad** | El texto de los mensajes nunca se guarda; los logs muestran solo los últimos 4 caracteres del número. |
| **Interfaz de salida** | `WhatsAppClient` tiene un mock (por defecto) y una implementación para la Cloud API. |

## Inicio rápido (sin cuenta de Meta)

Requiere Node.js 22.9 o superior. Los comandos y la salida real están en [README.md](README.md#-quickstart-no-meta-account-needed): `npm run dev` levanta el servidor en modo mock y `npm run simulate` le envía mensajes firmados. `npm test` corre 73 tests de Vitest.

## El mismo número en la app Business y en la API ("coexistencia")

Lo que dicen las guías de Meta (solo las leí; no probé nada de esto):

- Un negocio que ya usa la app WhatsApp Business puede sumarse a la Cloud API y seguir usando la app con el mismo número. El alta se hace a través de un Solution Partner o Tech Provider con Embedded Signup, y requiere la versión 2.24.17 o posterior de la app.
- Los mensajes se reflejan entre la app y la Cloud API. Cada mensaje enviado desde la app dispara un webhook `smb_message_echoes`.
- Límites que lista Meta: los grupos no se sincronizan; mensajes temporales, de ver una vez y ubicación en vivo quedan desactivados; las listas de difusión pasan a solo lectura; el número se desconecta si la app no se abre por unos 14 días; el rendimiento queda fijo en 20 mensajes por segundo.

Cómo lo usa este proyecto: un evento `smb_message_echoes` significa que una persona respondió desde la app, así que el bot se calla en ese chat.

## Probado vs no probado

**Probado (tests unitarios + simulador local):** handshake GET, firma aceptada/rechazada (incluye el vector de prueba HMAC del RFC 4231), entregas duplicadas y concurrentes, reinicio con la misma base, falla de envío y reintento, los tres caminos de traspaso, liberación, la carrera del traspaso, la forma del pedido a la Cloud API contra un `fetch` simulado.

**No probado contra Meta real:** firmas y payloads reales, la llamada real a la Graph API (`OUTBOUND_MODE=cloud`), un número real en coexistencia, eventos `smb_message_echoes` reales, los tiempos de reintento de Meta. Tampoco sé si los mensajes enviados por la API vuelven como eco; por las dudas, el código ignora los ecos de sus propios ids.

## Límites conocidos

- **Respuestas "al menos una vez".** Si el proceso muere después de enviar y antes de guardar, el reintento envía la misma respuesta otra vez.
- **Una respuesta que ya está en vuelo sale igual** si una persona toma el control justo en ese momento; solo se protege el estado.
- **Dos mensajes del mismo cliente procesados en el mismo instante** pueden contar ambos como el primer "no entendido", y el traspaso se atrasa un mensaje.
- **Sin límite de tasa**, y los ids guardados nunca se depuran.
- **No se controla la ventana de servicio de 24 horas**; el bot solo responde a mensajes entrantes, lo que normalmente lo mantiene dentro de la ventana.
- **Usuarios sin número visible** se identifican por su id de usuario; si la misma persona aparece después con número, cuenta como conversación nueva.
- **Intenciones por palabras clave** (inglés y español): se pierde todo lo que esté dicho de otra forma.
