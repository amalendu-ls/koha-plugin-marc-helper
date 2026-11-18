#!/usr/bin/perl
# Koha MARC Helper - tests for the relay's safety rules. GPL v3 or later.
# Run:  prove -I. t/relay.t   (needs LWP, URI and HTTP::Response, which Koha has)
use Modern::Perl;
use Test::More;
use HTTP::Response;
use MIME::Base64 qw(encode_base64 decode_base64);

use Koha::Plugin::MarcHelper::Relay;
my $R = 'Koha::Plugin::MarcHelper::Relay';

# Approved hosts only, https on port 443, no user names, no internal addresses
ok( $R->can('check_url'), 'relay loads' );
is( Koha::Plugin::MarcHelper::Relay::check_url('https://lx2.loc.gov/voyager?x=1'), undef, 'LC catalogue allowed' );
is( Koha::Plugin::MarcHelper::Relay::check_url('https://harvard.alma.exlibrisgroup.com/view/sru/x'), undef, 'Alma subdomain allowed' );
for my $bad (
    'http://lx2.loc.gov/',                      # not https
    'https://lx2.loc.gov:8443/',                # other port
    'https://evil.example.com/',                # not approved
    'https://loc.gov.evil.example/',            # look-alike
    'https://alma.exlibrisgroup.com.evil.io/',  # look-alike suffix
    'https://127.0.0.1/', 'https://localhost/', 'https://192.168.1.1/',
    'https://user@lx2.loc.gov/',                # user name in address
    'file:///etc/passwd', 'ftp://lx2.loc.gov/', 'not a url',
) {
    ok( defined Koha::Plugin::MarcHelper::Relay::check_url($bad), "refused: $bad" );
}

# Keys go only to the source they belong to
my $secrets = { googleApiKey => 'G-KEY', isbnDbApiKey => 'I-KEY', worldcatApiKey => 'W-KEY', worldcatApiSecret => 'W-SECRET' };
is( Koha::Plugin::MarcHelper::Relay::substitute( 'key=__KMH_KEY_googleApiKey__', $secrets, 'www.googleapis.com' ), 'key=G-KEY', 'Google key for Google' );
is( Koha::Plugin::MarcHelper::Relay::substitute( 'key=__KMH_KEY_googleApiKey__', $secrets, 'api.crossref.org' ), 'key=', 'Google key not sent elsewhere' );
is( Koha::Plugin::MarcHelper::Relay::substitute( '__KMH_KEY_unknown__', $secrets, 'www.googleapis.com' ), '', 'unknown placeholder emptied' );
my $basic = 'Basic ' . encode_base64( '__KMH_KEY_worldcatApiKey__:__KMH_KEY_worldcatApiSecret__', '' );
my $auth  = Koha::Plugin::MarcHelper::Relay::_authorization( $basic, $secrets, 'oauth.oclc.org' );
is( decode_base64( ( split / /, $auth )[1] ), 'W-KEY:W-SECRET', 'WorldCat Basic credentials rebuilt on the server' );

# fetch(): a pretend web client records what would be sent
{
    package FakeUA;
    sub new { my ( $class, @responses ) = @_; bless { responses => [@responses], sent => [] }, $class }
    sub request { my ( $self, $req ) = @_; push @{ $self->{sent} }, $req; return shift @{ $self->{responses} } }
}
sub response {
    my ( $code, $body, %headers ) = @_;
    my $res = HTTP::Response->new( $code, 'x', [ 'Content-Type' => 'text/plain; charset=UTF-8', %headers ], $body );
    return $res;
}

my $ua  = FakeUA->new( response( 200, 'hello' ) );
my $out = Koha::Plugin::MarcHelper::Relay::fetch(
    { url => 'https://www.googleapis.com/books/v1/volumes?q=x&key=__KMH_KEY_googleApiKey__', headers => { Accept => 'application/json', 'X-Evil' => 'y' } },
    $secrets, $ua );
is( $out->{status}, 200, 'answer passed back' );
is( $out->{body}, 'hello', 'body passed back' );
like( $ua->{sent}[0]->uri, qr/key=G-KEY/, 'key added on the server' );
ok( !$ua->{sent}[0]->header('X-Evil'), 'only listed headers forwarded' );

$ua  = FakeUA->new( response( 302, '', Location => 'https://evil.example.com/steal' ) );
$out = Koha::Plugin::MarcHelper::Relay::fetch( { url => 'https://openlibrary.org/isbn/1.json' }, $secrets, $ua );
is( $out->{status}, 0, 'redirect to an unapproved site refused' );
like( $out->{error}, qr/approved/, 'with an explanation' );
is( scalar @{ $ua->{sent} }, 1, 'the unapproved site was never contacted' );

$ua  = FakeUA->new( response( 302, '', Location => '/books/OL1M.json' ), response( 200, '{}' ) );
$out = Koha::Plugin::MarcHelper::Relay::fetch( { url => 'https://openlibrary.org/isbn/1.json' }, $secrets, $ua );
is( $out->{status}, 200, 'redirect within an approved source followed' );
is( $out->{url}, 'https://openlibrary.org/books/OL1M.json', 'final address reported' );

$ua  = FakeUA->new( response( 200, 'page', 'Set-Cookie' => 'SESSION=abc; Path=/' ), response( 200, 'results' ) );
$out = Koha::Plugin::MarcHelper::Relay::fetch( { url => 'https://indcat.inflibnet.ac.in/index.php/search' }, $secrets, $ua );
is_deeply( $out->{cookies}, ['SESSION=abc; Path=/'], 'session cookie passed back to the panel' );
Koha::Plugin::MarcHelper::Relay::fetch( { url => 'https://indcat.inflibnet.ac.in/index.php/search', method => 'POST', body => 'q=1', cookies => { SESSION => 'abc' } }, $secrets, $ua );
is( $ua->{sent}[1]->header('Cookie'), 'SESSION=abc', 'cookie sent back to the same source' );
is( $ua->{sent}[1]->content, 'q=1', 'POST body sent' );

$out = Koha::Plugin::MarcHelper::Relay::fetch( { url => 'https://lx2.loc.gov/', method => 'DELETE' }, $secrets, FakeUA->new );
is( $out->{error}, 'Method not allowed', 'only GET, POST and HEAD' );

# Koha OPACs the library listed are reached; other sites are not
{
    local @Koha::Plugin::MarcHelper::Relay::EXTRA_HOSTS = ('opac.example.org');
    ok( Koha::Plugin::MarcHelper::Relay::host_allowed('opac.example.org'), 'listed Koha OPAC allowed' );
    ok( !Koha::Plugin::MarcHelper::Relay::host_allowed('other.example.org'), 'an OPAC not listed refused' );
    like( Koha::Plugin::MarcHelper::Relay::check_url('http://opac.example.org/cgi-bin/koha/opac-search.pl') // '', qr/https/, 'listed OPAC over http refused' );
}
ok( !Koha::Plugin::MarcHelper::Relay::host_allowed('opac.example.org'), 'the list applies to one request only' );

# A listed Koha SRU server: exactly its scheme, host and port (http allowed for it)
{
    local @Koha::Plugin::MarcHelper::Relay::EXTRA_ORIGINS = ('http://sru.example.org:9999');
    is( Koha::Plugin::MarcHelper::Relay::check_url('http://sru.example.org:9999/biblios?query=x'), undef, 'listed SRU server allowed (http, its port)' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('http://sru.example.org:9998/biblios'), 'same host, another port refused' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('http://other.example.org:9999/biblios'), 'another host refused' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('http://user@sru.example.org:9999/biblios'), 'user name in the address refused' );
}

# AI Helper: only the chosen provider's one address, keys only to their own provider
{
    my $openai = 'https://api.openai.com/v1/chat/completions';
    ok( Koha::Plugin::MarcHelper::Relay::check_url($openai), 'AI provider refused while the AI Helper is off' );
    local @Koha::Plugin::MarcHelper::Relay::AI_URLS = ($openai);
    is( Koha::Plugin::MarcHelper::Relay::check_url($openai), undef, 'the chosen AI provider allowed' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('https://api.openai.com/v1/files'), 'other addresses of the provider refused' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('https://api.deepseek.com/v1/chat/completions'), 'a provider not chosen refused' );
    my $keys = { openaiApiKey => 'O-KEY', geminiApiKey => 'GM-KEY', copilotApiKey => 'AZ-KEY' };
    my $ua   = FakeUA->new( response( 200, '{"choices":[]}' ) );
    my $out  = Koha::Plugin::MarcHelper::Relay::fetch(
        { url => $openai, method => 'POST', headers => { Authorization => 'Bearer __KMH_KEY_openaiApiKey__', 'Content-Type' => 'application/json' },
          body => '{"messages":[{"content":"__KMH_KEY_geminiApiKey__"}]}' }, $keys, $ua );
    is( $ua->{sent}[0]->header('Authorization'), 'Bearer O-KEY', 'OpenAI key added on the server for OpenAI' );
    unlike( $ua->{sent}[0]->content, qr/GM-KEY/, 'another provider\'s key is not put into the request' );
    is( Koha::Plugin::MarcHelper::Relay::substitute( '__KMH_KEY_openaiApiKey__', $keys, 'api.deepseek.com' ), '', 'OpenAI key not sent to another provider' );

    my $gemini = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    local @Koha::Plugin::MarcHelper::Relay::AI_URLS = ($gemini);
    $ua = FakeUA->new( response( 200, '{}' ) );
    Koha::Plugin::MarcHelper::Relay::fetch( { url => $gemini, method => 'POST', headers => { 'x-goog-api-key' => '__KMH_KEY_geminiApiKey__' }, body => '{}' }, $keys, $ua );
    is( $ua->{sent}[0]->header('x-goog-api-key'), 'GM-KEY', 'Gemini key header filled on the server' );

    my $azure = 'https://lib.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-02-01';
    local @Koha::Plugin::MarcHelper::Relay::AI_URLS = ($azure);
    local %Koha::Plugin::MarcHelper::Relay::EXTRA_KEY_HOSTS = ( copilotApiKey => ['lib.openai.azure.com'] );
    $ua = FakeUA->new( response( 200, '{}' ) );
    Koha::Plugin::MarcHelper::Relay::fetch( { url => $azure, method => 'POST', headers => { 'api-key' => '__KMH_KEY_copilotApiKey__' }, body => '{}' }, $keys, $ua );
    is( $ua->{sent}[0]->header('api-key'), 'AZ-KEY', 'Azure key sent to the endpoint the library entered' );
    is( Koha::Plugin::MarcHelper::Relay::substitute( '__KMH_KEY_copilotApiKey__', $keys, 'other.openai.azure.com' ), '', '... and nowhere else' );

    local @Koha::Plugin::MarcHelper::Relay::AI_URLS = ('http://localhost:11434/api/generate');
    is( Koha::Plugin::MarcHelper::Relay::check_url('http://localhost:11434/api/generate'), undef, 'Ollama: its generate address allowed (http)' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('http://localhost:11434/api/pull'), 'Ollama: other addresses refused' );
    ok( Koha::Plugin::MarcHelper::Relay::check_url('http://localhost:8080/'), 'Ollama: the server\'s other ports refused' );
    $ua = FakeUA->new( response( 302, '', Location => 'http://localhost:8080/admin' ) );
    $out = Koha::Plugin::MarcHelper::Relay::fetch( { url => 'http://localhost:11434/api/generate', method => 'POST', body => '{}' }, $keys, $ua );
    ok( $out->{error}, 'Ollama: a redirect elsewhere is refused' );
}

# fetch_many: several at once, same checks, results in order
my $many = Koha::Plugin::MarcHelper::Relay::fetch_many(
    [ { url => 'https://example.com/' }, { url => 'http://lx2.loc.gov/' }, { url => 'https://lx2.loc.gov/', method => 'DELETE' } ], $secrets, 5 );
is( scalar @$many, 3, 'fetch_many: one result per request' );
like( $many->[0]{error}, qr/approved/, 'fetch_many: unapproved site refused' );
like( $many->[1]{error}, qr/https/, 'fetch_many: http refused' );
is( $many->[2]{error}, 'Method not allowed', 'fetch_many: method checked' );
is( scalar @{ Koha::Plugin::MarcHelper::Relay::fetch_many( [ map { { url => 'https://example.com/' } } 1 .. 40 ], $secrets, 5 ) },
    30, 'fetch_many: at most 30 requests per call' );

SKIP: {
    skip 'set MARCHELPER_LIVE=1 for network tests', 3 unless $ENV{MARCHELPER_LIVE};
    my $t0   = time;
    my $live = Koha::Plugin::MarcHelper::Relay::fetch_many(
        [   { url => 'https://lx2.loc.gov/sru/lcdb?version=1.1&operation=searchRetrieve&query=bath.isbn=9780262033848&recordSchema=marcxml&maximumRecords=1' },
            { url => 'https://libris.kb.se/xsearch?query=isbn:9780262033848&format=marcxml&n=1' },
            { url => 'https://sru.api.melinda.kansalliskirjasto.fi/bib?version=1.1&operation=searchRetrieve&query=bath.isbn%3D9780262033848&maximumRecords=1' },
        ], $secrets, 9 );
    my $secs = time - $t0;
    is( scalar( grep { ( $_->{status} // 0 ) == 200 } @$live ), 3, 'fetch_many live: three sources answered' ) or diag explain $live;
    like( $live->[1]{body} // '', qr/tag="245"/, 'fetch_many live: MARC record in the body' );
    ok( $secs <= 10, "fetch_many live: answered together within the deadline ($secs s)" );
}

done_testing();
