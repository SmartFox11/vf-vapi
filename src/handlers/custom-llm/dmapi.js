import { default as axios } from 'axios'

const conversationStates = new Map()

const getVoiceflowDomain = () => {
  const customDomain = process.env.VOICEFLOW_DOMAIN
  return customDomain
    ? `${customDomain}.general-runtime.voiceflow.com`
    : 'general-runtime.voiceflow.com'
}

const getTranscriptsDomain = () => {
  const customDomain = process.env.VOICEFLOW_DOMAIN
  return customDomain
    ? `api.${customDomain}.voiceflow.com`
    : 'api.voiceflow.com'
}

async function deleteUserState(user) {
  const request = {
    method: 'DELETE',
    url: `https://${getVoiceflowDomain()}/state/user/${encodeURI(user)}`,
    headers: {
      Authorization: process.env.VOICEFLOW_API_KEY,
      versionID: process.env.VOICEFLOW_VERSION_ID,
    },
  }
  const response = await axios(request)
  return response
}

async function saveTranscript(user) {
  axios({
    method: 'put',
    url: `https://${getTranscriptsDomain()}/v2/transcripts`,
    data: {
      browser: 'VAPI',
      device: 'Phone',
      os: 'VAPI',
      sessionID: user,
      unread: true,
      versionID: process.env.VOICEFLOW_VERSION_ID,
      projectID: process.env.VOICEFLOW_PROJECT_ID,
      user: {
        name: user,
        image:
          'https://s3.amazonaws.com/com.voiceflow.studio/share/3818df985d5f502f5dc4a6816903ce174528467f/3818df985d5f502f5dc4a6816903ce174528467f.png',
      },
    },
    headers: {
      Authorization: process.env.VOICEFLOW_API_KEY,
    },
  }).catch((err) => console.log(err))
}

export const api = async (req, res) => {
  try {
    console.log('API call received', JSON.stringify(req.body, null, 2));
    const {
      messages,
      call,
      tools,
    } = req.body

    const lastMessage = messages?.[messages.length - 1]

    let userId = call?.customer?.number || call.id
    const isNewConversation = !conversationStates.has(call.id)
    conversationStates.set(call.id, true)

    const baseRequest = {
      method: 'POST',
      url: `https://${getVoiceflowDomain()}/state/user/${encodeURI(
        userId
      )}/interact`,
      headers: {
        Authorization: process.env.VOICEFLOW_API_KEY,
        sessionID: userId,
        versionID: process.env.VOICEFLOW_VERSION_ID,
      },
      data: {
        config: { tts: false, stripSSML: true, stopTypes: ['DTMF'] },
      },
    }

    let response
    let shouldEndCall = false
    let shouldTransferCall = false

    if (isNewConversation) {
      await deleteUserState(userId)
      response = await axios({
        ...baseRequest,
        data: {
          ...baseRequest.data,
          action: { type: 'launch' },
        },
      })
    } else {
      response = await axios({
        ...baseRequest,
        data: {
          ...baseRequest.data,
          action: {
            type: 'text',
            payload: lastMessage.content,
          },
        },
      })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const chatId = `chatcmpl-${Math.floor(Date.now() / 1000)}`
    for (const trace of response.data) {
      console.log('Processing trace:', JSON.stringify(trace, null, 2));
      switch (trace.type) {
        case 'text':
        case 'speak': {
          if (trace.payload?.message) {
            const chunk = {
              id: chatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'dmapi',
              choices: [
                {
                  index: 0,
                  delta: { content: trace.payload.message },
                  finish_reason: null,
                },
              ],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
          break
        }
        case 'end': {
          shouldEndCall = true
          break
        }
        case 'custom': {
          console.log('Custom trace received:', JSON.stringify(trace, null, 2));
  if (trace.type === 'Handoff Human') {
    console.log('Handoff human triggered');
    shouldTransferCall = true;
  } else if (trace.payload && trace.payload.type === 'end_call') {
    console.log('End call triggered');
    shouldEndCall = true;
  }
  break;
        }
case 'Handoff Human': {
  console.log('Handoff human trace received');
  console.log('Payload:', trace.payload);
  try {
    const payloadObj = JSON.parse(trace.payload);
    if (payloadObj.type === 'transferCall') {
      console.log('Transfer call triggered');
      shouldTransferCall = true;
    }
  } catch (error) {
    console.error('Error parsing payload:', error);
    // Fallback: Wenn das Parsen fehlschlägt, nehmen wir an, dass eine Weiterleitung gewünscht ist
    shouldTransferCall = true;
  }
  break;
}
        default: {
          console.log('Unknown trace type', trace)
        }
      }
    }
    
if (shouldTransferCall) {
  console.log('Attempting to transfer call');
  const transferChunk = {
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'dmapi',
    choices: [
      {
        index: 0,
        delta: {
          content: null,
          function_call: {
            name: 'transferCall',
            arguments: JSON.stringify({
              destination: process.env.FORWARDING_PHONE_NUMBER
            })
          }
        },
        finish_reason: null,
      },
    ],
  };
  console.log('Sending transfer chunk:', JSON.stringify(transferChunk, null, 2));
  res.write(`data: ${JSON.stringify(transferChunk)}\n\n`);
  return res.end(); // End the response after transfer
}

    if (shouldEndCall) {
      console.log('Attempting to end call');
      const endCallChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'dmapi',
        choices: [
          {
            index: 0,
            delta: {
              content: null,
              function_call: {
                name: 'endCall',
                arguments: '{}'
              }
            },
            finish_reason: null,
          },
        ],
      }
      console.log('Sending end call chunk:', JSON.stringify(endCallChunk, null, 2));
      res.write(`data: ${JSON.stringify(endCallChunk)}\n\n`)
    } else {
      const finalChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'dmapi',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
    }
    res.write(`data: [DONE]\n\n`)
    res.end()
    saveTranscript(userId)
  } catch (e) {
    console.error('Error in API:', e);
    res.status(500).json({ error: e.message })
  }
}
