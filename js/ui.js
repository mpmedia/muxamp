$('#previous').live('click', function() {
    playlist.previousTrack();
});

$('#play').live('click', function() {
    if (playlist.isPlaying()) {
        playlist.togglePause();
    }
    else {
        playlist.play();
    }
});

$('#next').live('click', function() {
    playlist.nextTrack();
});

$('#stop').live('click', function() {
    playlist.stop();
});

$('#adder-button').live('click', function(){
    var value = $('#adder-link').val();
    router.addTracks(value);
    $('#adder-link').val("");
});