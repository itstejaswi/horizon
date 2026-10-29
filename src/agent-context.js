"use strict";

function resources(settings) {
  return {
    approvedFolders: settings.roots,
    configuredCommands: settings.commands.map(command => ({ id: command.id, executable: command.executable, args: command.args })),
    configuredMcpServers: settings.mcpServers.map(server => ({ id: server.id }))
  };
}

function conversationInstructions(history = []) {
  return history.filter(message => message.role === "system").map(message => message.content).join("\n");
}

// Greetings, thanks and acknowledgements need no tools. Only this fixed list
// counts, so anything that could be a request (a URL, a question, "open…")
// still goes through the tool loop and is never silently denied tools.
const SMALL_TALK = /^(?:hi+|hello|hey+|hiya|yo|good (?:morning|afternoon|evening|night)|thanks|thank you|thank u|thx|ty|cheers|ok|okay|k|cool|great|nice|awesome|perfect|bye|goodbye|see you|got it|sounds good)(?:\s+(?:there|again|so much|a lot|all))?[\s!.,:;)(\p{Extended_Pictographic}️]*$/iu;

function isSmallTalk(text) {
  return typeof text === "string" && text.trim().length <= 40 && SMALL_TALK.test(text.trim());
}

// A tool run re-reads its whole history on every model call, which is slow on
// a CPU and lets old failures steer small models. Keep the system instruction
// and only the most recent turns; the full chat stays on the page.
const TOOL_HISTORY_TURNS = 8;

function recentHistory(messages, turns = TOOL_HISTORY_TURNS) {
  const system = messages.filter(message => message.role === "system");
  const rest = messages.filter(message => message.role !== "system");
  return [...system, ...rest.slice(-turns)];
}

module.exports = { resources, conversationInstructions, isSmallTalk, recentHistory, TOOL_HISTORY_TURNS };
