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

module.exports = { resources, conversationInstructions };
