var SearchResult	= require('./searchresult').SearchResult,
	_				= require('underscore')._,
	$ 				= require('jquery-deferred'),
	request 		= require('request'),
	db				= require('./db'),
	cacher			= require('node-dummy-cache'),
	mediaRouter		= require('./router').getRouter(),
	url				= require('url');
	
var dbConnectionPool 	= db.getConnectionPool(),
	searchResultsCache	= cacher.create(cacher.ONE_SECOND * 30, cacher.ONE_SECOND * 10);

var getSeparatedWords = function(query) {
	return query.replace(/[^\w\s]|_/g, ' ').toLowerCase().split(' ');
};

var allPropertiesExist = function(object, expected) {
	return _.all(expected, function (element) {
		var value = object[element];
		return !(value == null || value == undefined);
	});
}

function SearchManager () {
	this.resultCount = 25;
	this.soundcloudCheckedProperties = [
		'stream_url', 'permalink_url'
	];
	this.soundcloudKey = "2f9bebd6bcd85fa5acb916b14aeef9a4";
	this.soundcloudSearchURI = "http://api.soundcloud.com/tracks.json?client_id=" + this.soundcloudKey + "&limit=" + this.resultCount + "&filter=streamable&order=hotness";
	this.youtubeSearchURI = "https://gdata.youtube.com/feeds/api/videos?v=2&format=5&max-results=" + this.resultCount + "&orderby=relevance&alt=json";
	this.youtubeCheckedProperties = [
		'author', 'title', 'yt$statistics', 'media$group'
	];
	this.reset();
}

SearchManager.prototype = {
	checkMaxFavorites: function(favs) {
		if (favs > this.maxFavorites) {
			this.maxFavorites = favs;
		}
	},
    checkMaxPlays: function(plays) {
		if (plays > this.maxPlays) {
			this.maxPlays = plays;
		}
	},
	reset: function() {
		this.maxFavorites = 0;
		this.maxPlays = 0;
	},
	saveSearchResults: function(searchResults) {
		var result, i;
		
		if (searchResults && searchResults.length) {
			dbConnectionPool.acquire(function(acquireError, connection) {
				if (!acquireError) {
					var queryString = ["INSERT INTO KnownMedia (site, mediaid) VALUES "];
					for (i in searchResults) {
						result = searchResults[i];
						queryString.push("(" + connection.escape(result.siteCode.toLowerCase()) + "," + connection.escape(result.siteMediaID) + ")");
						if (parseInt(i) < searchResults.length - 1) {
							queryString.push(",");
						}
						else {
							queryString.push(" ON DUPLICATE KEY UPDATE id=id;");
						}
					}
					connection.query(queryString.join(""), function(queryError, rows) {
						dbConnectionPool.release(connection);
					});
				}
				else {
					dbConnectionPool.release(connection);
				}
			});
		}
	},
	search: function(query, page, site) {
		this.reset();
		page = Math.max(parseInt(page || '0'), 0);
		var deferred, searchManager = this;
		var cacheKey = {query: query, page: page, site: site};
		var cachedResults = searchResultsCache.get(cacheKey);
		if (!cachedResults) {
			var isURL = false;
			var parsedURL = url.parse(query);
			if (parsedURL && parsedURL.href && parsedURL.href.indexOf('http') >= 0) {
				isURL = true;
			}
			switch(site) {
				case 'sct':
					if (isURL) {
						deferred = mediaRouter.addResource(query, false, ['YouTube', 'Internet']);
					}
					else {
						deferred = this.searchSoundCloudTracks(query, page);
					}
					break;
				case 'ytv':
					if (isURL) {
						deferred = mediaRouter.addResource(query, false, ['SoundCloud', 'Internet']);
					}
					else {
						deferred = this.searchYouTubeVideos(query, page);
					}
					break;
				case 'url':
					if (isURL) {
						deferred = mediaRouter.addResource(query);
					}
					else {
						deferred = $.Deferred();
						deferred.reject();
						deferred = deferred.promise();
					}
					break;
			}
		}
		else {
			deferred = $.Deferred();
			deferred.resolve(cachedResults);
			deferred = deferred.promise();
		}
		return deferred.pipe(function(results) {
			searchManager.saveSearchResults(results);
			if (!cachedResults) {
				var i;
				for (i in results) {
					// If negative plays, searches list for next instance of positive plays
					// and punishes the result by giving it the number of plays of whatever 
					// track meets the criteria
					if (results[i].plays < 0) {
						var newPlays = 0, newFavorites = 0, j;
						for (j = -1 * results[i].plays; j < results.length; j++) {
							if (results[j].plays >= 0) {
								newPlays = results[j].plays;
								newFavorites = results[j].plays;
								break;
							}
						}
						results[i].plays = newPlays;
						results[i].favorites = newFavorites;
					}
					var plays = results[i].plays, favs = results[i].favorites;
					results[i].playRelevance = Math.log(plays + 1) / Math.log(searchManager.maxPlays + 1);
					results[i].favoriteRelevance = Math.log(favs + 1) / Math.log(searchManager.maxFavorites + 1);
					results[i].calculateRelevance();
				}
				results.sort(function(a, b) {
					return b.relevance - a.relevance;
				});
				for (i in results) {
					delete results[i].favoriteRelevance;
					delete results[i].favorites;
					delete results[i].playRelevance;
					delete results[i].plays;
					delete results[i].querySimilarity;
					delete results[i].relevance;
				}
			}
			else {
				results = cachedResults;
				if (results.length) {
					searchResultsCache.put(cacheKey, results);
				}
			}
			return results;
		},
		function(failedResults) {
			return [];
		});
	},
	searchSoundCloudTracks: function(query, page) {
		var soundcloudConsumerKey = '2f9bebd6bcd85fa5acb916b14aeef9a4';
		var searchManager = this;
		var deferred = $.Deferred();
		var words = getSeparatedWords(query);
		request({
			json: true,
			method: 'GET',
			timeout: 5000,
			url: searchManager.soundcloudSearchURI + '&offset=' + (searchManager.resultCount * page + 1) + '&q=' + encodeURIComponent(query)
		}, function(error, response, body) {
			if (error || response.statusCode != 200) {
				deferred.reject();
				return;
			}
			var i, results = [];
			for (i in body) {
				var tryID, result = body[i], validEntry = allPropertiesExist(result, searchManager.soundcloudCheckedProperties);
				if (!validEntry) {
					tryID = 'unknown';
					if (result && result.id) {
						tryID = result.id;
					}
					console.log("SoundCloud entry " + tryID + ' is missing an essential property');
					continue;
				}
				if (undefined == result.playback_count) {
                			result.playback_count = -1 * parseInt(i) - 1;
                			result.favoritings_count = -1 * parseInt(i) - 1;
				}
				var searchResult = new SearchResult(result.stream_url + "?client_id=" + soundcloudConsumerKey, result.permalink_url, result.id, "sct", "img/soundcloud_orange_white_16.png", result.user.username, result.title, result.duration / 1000, "audio", result.playback_count, result.favoritings_count);
				var resultWords = getSeparatedWords(searchResult.author + ' ' + searchResult.mediaName);
				var intersection = _.intersection(words, resultWords);
				searchResult.querySimilarity = intersection.length / words.length;
				searchManager.checkMaxPlays(searchResult.plays);
				searchManager.checkMaxFavorites(searchResult.favorites);
				results.push(searchResult);
			}
			deferred.resolve(results);
		});
		return deferred.promise();
	},	
	searchYouTubeVideos: function(query, page) {	
		var searchManager = this;
		var deferred = $.Deferred();
		var words = getSeparatedWords(query);
		request({
			json: true,
			method: 'GET',
			timeout: 5000,
			url: searchManager.youtubeSearchURI + '&start-index='  + (searchManager.resultCount * page + 1) + '&q=' + encodeURIComponent(query)
		}, function(error, response, body) {
			if (error || response.statusCode != 200) {
				deferred.reject();
				return;
			}
			var i, results = [];
			var feed = body.feed;
			if (!feed) {
				return results;
			}
			var videos = feed.entry;
			if (!videos) {
				return results;
			}
			var validEntry, prop, tryID;
			for (i in videos) {
				var entry = videos[i];
				validEntry = allPropertiesExist(entry, searchManager.youtubeCheckedProperties);
				if (!validEntry) {
					tryID = 'unknown';
					if (entry && entry['id'] && entry['id']['$t']) {
						tryID = entry['id']['$t'].split(':').pop();
					}
					console.log("YouTube entry " + tryID + ' is missing an essential property');
					continue;
				}
				var id = entry['id']['$t'].split(':').pop();
				var permalink = 'http://www.youtube.com/watch?v=' + id;
				var authorObj = entry.author[0];
	            var author = authorObj.name.$t;
				var title = entry.title.$t;
	            var duration = parseInt(entry.media$group.yt$duration.seconds);
	            var viewCount = entry['yt$statistics']['viewCount'];
	            var favoriteCount = entry['yt$statistics']['favoriteCount'];
	            
	            var searchResult = new SearchResult(permalink, permalink, id, "ytv", "img/youtube.png", author, title, duration, "video", viewCount, favoriteCount);
				var resultWords = getSeparatedWords(searchResult.author + ' ' + searchResult.mediaName);
				var intersection = _.intersection(words, resultWords);
				searchResult.querySimilarity = intersection.length / words.length;
				searchManager.checkMaxPlays(searchResult.plays);
				searchManager.checkMaxFavorites(searchResult.favorites);
				results.push(searchResult);
			}
			deferred.resolve(results);
		});
		return deferred.promise();
	}
};

module.exports = {
  search: function() {
	return new SearchManager();
  },
  searchResult: SearchResult
};