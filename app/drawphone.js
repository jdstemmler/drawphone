/*
 *  Drawphone Game Logic
 *  By Tanner Krewson
 */

var shuffle = require('knuth-shuffle').knuthShuffle;

var getRandomWord = require('./words.js');

function Drawphone(devModeEnabled) {
	this.games = [];

	//add the dev game
	if (devModeEnabled) {
		this.newGame('ffff');
	}
}

Drawphone.prototype.newGame = function (forceCode) {

	var newCode;
	if (forceCode) {
		newCode = forceCode;
	} else {
		newCode = this.generateCode();
	}

	var self = this;
	var newGame = new Game(newCode, function () {
		//will be ran when this game has 0 players left
		self.removeGame(newCode);
	});
	this.games.push(newGame);
	console.log(newCode + ' created');
	return newGame;
};

Drawphone.prototype.findGame = function (code) {
	for (var i = 0; i < this.games.length; i++) {
		if (this.games[i].code === code.toLowerCase()) {
			return this.games[i];
		}
	}
	return false;
};

Drawphone.prototype.generateCode = function () {
	var code;
	do {
		//generate 4 letter code
		code = '';
		var possible = 'abcdefghijklmnopqrstuvwxyz';
		for (var i = 0; i < 4; i++) {
			code += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		//make sure the code is not already in use
	} while (this.findGame(code));
	return code;
};

Drawphone.prototype.removeGame = function (code) {
	var game = this.findGame(code);

	var index = this.games.indexOf(game);
	if (index > -1) {
		this.games.splice(index, 1);
		console.log(code + ' removed');
	}
};


function Game(code, onEmpty) {
	this.code = code;
	this.onEmpty = onEmpty;
	this.players = [];
	this.admin;
	this.inProgress = false;
	this.viewingResults = false;
	this.currentRound;

	this.currentId = 1;
	this.currentRoundNum = 1;
}

Game.prototype.newPlayer = function (name, socket) {
	return new Player(name, socket, this.getNextId());
};

Game.prototype.addPlayer = function (name, socket) {
	var newPlayer = this.newPlayer(name, socket);
	this.initPlayer(newPlayer);
	this.players.push(newPlayer);
	this.sendUpdatedPlayersList();
	return newPlayer;
};

Game.prototype.initPlayer = function (newPlayer) {
	//if this is the first user, make them admin
	if (this.players.length === 0) {
		this.admin = newPlayer;
		newPlayer.makeAdmin();
	}

	//when this player disconnects, remove them from this game
	var self = this;
	newPlayer.socket.on('disconnect', function () {
		newPlayer.isConnected = false;
		if (self.inProgress) {
			self.currentRound.findReplacementFor(newPlayer);
		} else {
			self.removePlayer(newPlayer.id);
		}
		self.onPlayerDisconnect(newPlayer);
		self.sendUpdatedPlayersList();
	});
};

Game.prototype.onPlayerDisconnect = function (oldPlayer) {
	//if the player was admin
	if (oldPlayer.id === this.admin.id) {
		//find the first connected player to be admin
		for (var i = 0; i < this.players.length; i++) {
			var thisPlayer = this.players[i];
			if (thisPlayer.isConnected) {
				this.admin = thisPlayer;
				thisPlayer.makeAdmin();
				break;
			}
		}
	}

	//if someone leaves while viewing results, we need to check again
	//  or everyone will get stuck on the Thanks for playing screen
	if (this.viewingResults) {
		this.currentRound.end();
	}

	var allPlayersDisconnected = true;
	for (var j = 0; j < this.players.length; j++) {
		if (this.players[j].isConnected) {
			allPlayersDisconnected = false;
			break;
		}
	}
	if (allPlayersDisconnected) {
		this.onEmpty();
	}
};

Game.prototype.removePlayer = function (id) {
	var player = this.getPlayer(id);

	var index = this.players.indexOf(player);
	if (index > -1) {
		this.players.splice(index, 1);
	}

	//if there are no players left
	if (this.players.length === 0) {
		this.onEmpty();
	}
};

Game.prototype.getPlayer = function (id) {
	for (var i = 0; i < this.players.length; i++) {
		if (this.players[i].id === id) {
			return this.players[i];
		}
	}
	return false;
};

Game.prototype.getNextId = function () {
	return this.currentId++;
};

Game.prototype.getNextRoundNum = function () {
	return this.currentRoundNum++;
};

Game.prototype.getJsonGame = function () {
	var players = [];
	this.players.forEach(function (player) {
		players.push(player.getJson());
	});

	var jsonGame = {
		code: this.code,
		players,
		inProgress: this.inProgress
	};
	return jsonGame;
};

Game.prototype.sendUpdatedPlayersList = function () {
	this.sendToAll('updatePlayerList', this.getJsonGame().players);
};

Game.prototype.sendToAll = function (event, data) {
	var self = this;
	this.players.forEach(function (player) {
		player.socket.emit(event, {
			success: true,
			gameCode: self.code,
			player: player.getJson(),
			data
		});
	});
};

Game.prototype.startNewRound = function () {
	this.inProgress = true;

	var self = this;
	this.currentRound = new Round(this.getNextRoundNum(), this.players, function () {
		//ran when results are sent
		self.inProgress = false;
		self.viewingResults = true;
	}, function () {
		//ran when everyone is done viewing results
		self.sendUpdatedPlayersList();
		self.viewingResults = false;
	});

	this.currentRound.start();
};


function Round(number, players, onResults, onEnd) {
	this.number = number;
	this.players = players;
	this.onResults = onResults;
	this.onEnd = onEnd;
	this.chains = [];
	this.disconnectedPlayers = [];
	//on creation, chains will already have one link
	this.shouldHaveThisManyLinks = 2;

	this.finalNumOfLinks;
}

Round.prototype.start = function () {
	//each player will have to complete one link for how many players there are
	//  the final number of links each chain should have at the end of this
	//  round is number of players + 1, because each chain has an extra link
	//  for the original word
	this.finalNumOfLinks = this.players.length + 1;

	//shuffle the player list in place
	shuffle(this.players);

	var currentChainId = 0;
	var self = this;
	this.players.forEach(function (player) {
		//give each player a chain of their own
		var thisChain = new Chain(getRandomWord(), player, currentChainId++);
		self.chains.push(thisChain);

		//sends the link, then runs the function when the player sends it back
		//  when the 'finishedLink' event is received
		thisChain.sendLastLinkToThen(player, self.finalNumOfLinks, function (data) {
			self.receiveLink(player, data.link, thisChain.id);
		});

	});

};

Round.prototype.receiveLink = function (player, receivedLink, chainId) {
	var chain = this.getChain(chainId);

	if (receivedLink.type === 'drawing') {
		chain.addLink(new DrawingLink(player, receivedLink.data));
	} else if (receivedLink.type === 'word') {
		chain.addLink(new WordLink(player, receivedLink.data));
	} else {
		console.log('receivedLink.type is ' + receivedLink.type);
	}

	this.updateWaitingList();
	this.nextLinkIfEveryoneIsDone();
};

Round.prototype.nextLinkIfEveryoneIsDone = function () {
	var listNotFinished = this.getListOfNotFinishedPlayers();
	var allFinished = listNotFinished.length === 0;
	var noneDisconnected = this.disconnectedPlayers.length === 0;

	if (allFinished && noneDisconnected) {
		//check if that was the last link
		if (this.shouldHaveThisManyLinks === this.finalNumOfLinks) {
			this.viewResults();
		} else {
			this.startNextLink();
		}
	}
};

Round.prototype.startNextLink = function () {
	this.shouldHaveThisManyLinks++;

	//rotate the chains in place
	//  this is so that players get a chain they have not already had
	this.chains.push(this.chains.shift());

	//distribute the chains to each player
	//  players and chains will have the same length
	var self = this;
	for (var i = 0; i < this.players.length; i++) {
		var thisChain = this.chains[i];
		var thisPlayer = this.players[i];

		thisChain.lastPlayerSentTo = thisPlayer.getJson();

		//sends the link, then runs the function when the player sends it back
		//  when the 'finishedLink' event is received
		(function (chain, player) {
			chain.sendLastLinkToThen(player, self.finalNumOfLinks, function (data) {
				self.receiveLink(player, data.link, chain.id);
			});
		})(thisChain, thisPlayer);

	}
};

Round.prototype.getChain = function (id) {
	for (var i = 0; i < this.chains.length; i++) {
		if (this.chains[i].id === id) {
			return this.chains[i];
		}
	}
	return false;
};

Round.prototype.getChainByOwnerId = function (ownerId) {
	for (var i = 0; i < this.chains.length; i++) {
		if (this.chains[i].owner.id === ownerId) {
			return this.chains[i];
		}
	}
	return false;
};

Round.prototype.viewResults = function () {
	this.onResults();

	var chains = this.getAllChains();

	var self = this;
	this.players.forEach(function (player) {
		player.sendThen('viewResults', {
			chains
		}, 'doneViewingResults', function () {
			player.doneViewingResults = true;
			self.end();
		});

	});
};

Round.prototype.end = function () {
	//check to see if all players are done viewing results
	var allDone = true;
	for (var i = 0; i < this.players.length; i++) {
		var player = this.players[i];
		if (!player.doneViewingResults && player.isConnected) {
			allDone = false;
			break;
		}
	}

	if (allDone) {
		this.onEnd();
		this.players.forEach(function (player) {
			//set it back for the next round
			player.doneViewingResults = false;

			player.send('roundOver', {});
		});
	}
};

Round.prototype.findReplacementFor = function (player) {
	this.disconnectedPlayers.push(player.getJson());
	this.updateWaitingList();
};

Round.prototype.getPlayersThatNeedToBeReplaced = function () {
	return this.disconnectedPlayers;
};

Round.prototype.canBeReplaced = function (playerToReplaceId) {
	for (var i = 0; i < this.disconnectedPlayers.length; i++) {
		if (this.disconnectedPlayers[i].id === playerToReplaceId) {
			return true;
		}
	}
	return false;
};

Round.prototype.replacePlayer = function (playerToReplaceId, newPlayer) {
	for (var i = 0; i < this.disconnectedPlayers.length; i++) {
		if (this.disconnectedPlayers[i].id === playerToReplaceId) {
			//give 'em the id of the old player
			newPlayer.id = this.disconnectedPlayers[i].id;

			//replace 'em
			var playerToReplaceIndex = this.getPlayerIndexById(playerToReplaceId);
			this.players[playerToReplaceIndex] = newPlayer;

			//delete 'em from disconnectedPlayers
			this.disconnectedPlayers.splice(i, 1);

			//check if the disconnectedPlayer (dp) had submitted their link
			var dpChain = this.getChainByLastSentPlayerId(newPlayer.id);
			var dpDidFinishTheirLink = dpChain.getLength() === this.shouldHaveThisManyLinks;
			if (dpDidFinishTheirLink) {
				//send this player to the waiting for players page
				newPlayer.socket.emit('showWaitingList', {});
			} else {
				//send them the link they need to finish
				var self = this;
				dpChain.sendLastLinkToThen(newPlayer, this.finalNumOfLinks, function (data) {
					self.receiveLink(newPlayer, data.link, dpChain.id);
				});
			}
			return this.players[playerToReplaceIndex];
		}
	}
};

Round.prototype.updateWaitingList = function () {
	this.sendToAll('updateWaitingList', {
		notFinished: this.getListOfNotFinishedPlayers(),
		disconnected: this.disconnectedPlayers
	});
};

Round.prototype.getListOfNotFinishedPlayers = function () {
	var playerList = [];

	//check to make sure every chain is the same length
	for (var i = 0; i < this.chains.length; i++) {
		var thisChain = this.chains[i];
		var isLastPlayerSentToConnected = this.getPlayer(thisChain.lastPlayerSentTo.id).isConnected;

		if (thisChain.getLength() !== this.shouldHaveThisManyLinks && isLastPlayerSentToConnected) {
			playerList.push(thisChain.lastPlayerSentTo);
		}
	}

	return playerList;
};

Round.prototype.getPlayer = function (id) {
	for (var i = 0; i < this.players.length; i++) {
		if (this.players[i].id === id) {
			return this.players[i];
		}
	}
	return false;
};

Round.prototype.getPlayerIndexById = function (id) {
	for (var i = 0; i < this.players.length; i++) {
		if (this.players[i].id === id) {
			return i;
		}
	}
	return false;
};

Round.prototype.getChainByLastSentPlayerId = function (id) {
	for (var i = 0; i < this.chains.length; i++) {
		if (this.chains[i].lastPlayerSentTo.id === id) {
			return this.chains[i];
		}
	}
	return false;
};

Round.prototype.sendToAll = function (event, data) {
	this.players.forEach(function (player) {
		player.send(event, data);
	});
};

Round.prototype.getAllChains = function() {
	var newChains = [];
	this.chains.forEach(function(chain) {
		newChains.push(chain.getJson());
	});
	return newChains;
};


// A chain is the 'chain' of drawings and words.
// A link is the individual drawing or word in the chain.
function Chain(firstWord, owner, id) {
	this.owner = owner;
	this.links = [];
	this.id = id;

	this.lastPlayerSentTo = owner.getJson();

	this.addLink(new WordLink(this.owner, firstWord));
}

Chain.prototype.addLink = function (link) {
	this.links.push(link);
};

Chain.prototype.getLastLink = function () {
	return this.links[this.links.length - 1];
};

Chain.prototype.getLength = function () {
	return this.links.length;
};

//returns true if the player has a link in this chain already
Chain.prototype.playerHasLink = function (player) {
	for (var i = 0; i < this.links.length; i++) {
		if (this.links[i].player.id === player.id) {
			return true;
		}
	}
	return false;
};

Chain.prototype.sendLastLinkToThen = function (player, finalCount, next) {
	//sends the link, then runs the second function
	//  when the 'finishedLink' event is received
	player.sendThen('nextLink', {
		link: this.getLastLink(),
		chainId: this.id,
		count: this.getLength(),
		finalCount: finalCount - 1
	}, 'finishedLink', next);
};

Chain.prototype.getJson = function() {
	return {
		owner: this.owner.getJson(),
		links: this.links,
		id: this.id
	};
};


function DrawingLink(player, drawing) {
	Link.call(this, player, drawing);
	this.type = 'drawing';
}
DrawingLink.prototype = Object.create(Link.prototype);


function WordLink(player, word) {
	Link.call(this, player, word);
	this.type = 'word';
}
WordLink.prototype = Object.create(Link.prototype);


function Link(player, data) {
	this.player = player.getJson();
	this.data = data;
}


function Player(name, socket, id) {
	this.name = name;
	this.socket = socket;
	this.id = id;
	this.doneViewingResults = false;
	this.isAdmin = false;
	this.isConnected = true;
}

Player.prototype.getJson = function () {
	return {
		name: this.name,
		id: this.id,
		isAdmin: this.isAdmin,
		isConnected: this.isConnected
	};
};

Player.prototype.send = function (event, data) {
	this.socket.emit(event, {
		you: this.getJson(),
		data
	});
};

Player.prototype.sendThen = function (event, data, onEvent, next) {
	this.send(event, data);
	this.socket.once(onEvent, next);
};

Player.prototype.makeAdmin = function () {
	this.isAdmin = true;
};


module.exports = Drawphone;