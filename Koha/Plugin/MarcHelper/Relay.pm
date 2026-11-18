package Koha::Plugin::MarcHelper::Relay;

# Koha MARC Helper - a Koha plugin for copy cataloguing
# Copyright (C) 2026 Amalendu Das
#
# This program is free software: you can redistribute it and/or modify it under the
# terms of the GNU General Public License as published by the Free Software Foundation,
# either version 3 of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
# PARTICULAR PURPOSE. See the GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along with this
# program. If not, see <https://www.gnu.org/licenses/>.

# The relay fetches book data for the panel on Koha's cataloguing page. A Koha page
# may not fetch from other websites itself, so the panel asks the server instead.
# Only the approved book sources can be reached (https, port 443, by host name),
# so the relay cannot be used to reach other sites or the library's own network.
# API keys stay on the server: the panel sends placeholders (__KMH_KEY_name__) and
# the relay puts in the real key, only for the source that key belongs to.

use Modern::Perl;
use LWP::UserAgent;
use HTTP::Request;
use URI;
use MIME::Base64 qw(encode_base64 decode_base64);

our @ALLOWED_HOSTS = qw(
    lx2.loc.gov id.loc.gov
    indcat.inflibnet.ac.in isbn.gov.in
    www.googleapis.com
    sru.k10plus.de api.crossref.org
    oauth.oclc.org americas.discovery.api.oclc.org
    api.isbndb.com gutendex.com
    archive.org openlibrary.org
    swisscovery.slsp.ch libris.kb.se sru.api.melinda.kansalliskirjasto.fi ci.nii.ac.jp
);
our @ALLOWED_SUFFIXES = qw( .alma.exlibrisgroup.com .archive.org );

# The Koha OPACs the library listed in the plugin's settings, set for each request
# (local @EXTRA_HOSTS in the controller): searched as sources, https only like the rest
our @EXTRA_HOSTS;
# The exact origins ("http://host:9999") of Koha SRU servers the library listed
our @EXTRA_ORIGINS;
# AI Helper: the one address of the AI provider the library chose (scheme, host, port and
# path exactly; the query may vary), set for each request like the OPACs. Nothing else of
# that provider's host, and nothing at all when the AI Helper is off.
our @AI_URLS;
# Keys bound to a host the library entered (Azure OpenAI: its endpoint's host)
our %EXTRA_KEY_HOSTS;
our $AI_TIMEOUT = 120;    # a model can take a minute to answer

# Which source each key may be sent to
our %KEY_HOSTS = (
    googleApiKey      => [ 'www.googleapis.com' ],
    worldcatApiKey    => [ 'oauth.oclc.org', 'americas.discovery.api.oclc.org' ],
    worldcatApiSecret => [ 'oauth.oclc.org' ],
    isbnDbApiKey      => [ 'api.isbndb.com' ],
    openaiApiKey      => [ 'api.openai.com' ],
    geminiApiKey      => [ 'generativelanguage.googleapis.com' ],
    deepseekApiKey    => [ 'api.deepseek.com' ],
    perplexityApiKey  => [ 'api.perplexity.ai' ],
);

# Gemini takes its key in x-goog-api-key, Azure OpenAI in api-key
our @FORWARD_HEADERS = qw( accept content-type authorization x-goog-api-key api-key );
our $MAX_REDIRECTS   = 5;
our $MAX_BYTES       = 5_000_000;
our $TIMEOUT         = 15;

sub host_allowed {
    my ($host) = @_;
    $host = lc( $host // '' );
    return 0 unless $host;
    return 1 if grep { $_ eq $host } @ALLOWED_HOSTS, @EXTRA_HOSTS;
    return 1 if grep { length($host) > length($_) && substr( $host, -length($_) ) eq $_ } @ALLOWED_SUFFIXES;
    return 0;
}

# The address without its query: scheme://host:port/path
sub _url_base {
    my ($uri) = @_;
    return sprintf( '%s://%s:%d%s', lc( $uri->scheme // '' ), lc( $uri->host // '' ), $uri->port, $uri->path || '/' );
}

sub is_ai_url {
    my ($url) = @_;
    my $uri = eval { URI->new($url) };
    return 0 unless $uri && $uri->can('host') && $uri->host;
    my $base = _url_base($uri);
    return ( grep { my $u = eval { URI->new($_) }; $u && $u->can('host') && _url_base($u) eq $base } @AI_URLS ) ? 1 : 0;
}

# Returns an error message, or undef when the address may be fetched
sub check_url {
    my ($url) = @_;
    my $uri = eval { URI->new($url) };
    return 'Not a web address' unless $uri && $uri->can('host');
    # The chosen AI provider's one address
    if ( is_ai_url($url) ) {
        return 'User names in addresses are not allowed' if defined $uri->userinfo;
        return;
    }
    # A listed Koha SRU server: exactly its scheme, host and port
    if ( $uri->can('host') && grep { $_ eq sprintf( '%s://%s:%d', lc( $uri->scheme // '' ), lc( $uri->host // '' ), $uri->port ) } @EXTRA_ORIGINS ) {
        return 'User names in addresses are not allowed' if defined $uri->userinfo;
        return;
    }
    return 'Only https addresses are allowed' unless ( $uri->scheme // '' ) eq 'https';
    return 'Address is not one of the approved book sources' unless host_allowed( $uri->host );
    return 'Port not allowed' unless $uri->port == 443;
    return 'User names in addresses are not allowed' if defined $uri->userinfo;
    return;
}

# Put real keys in place of __KMH_KEY_name__, only for the hosts that key belongs to
sub substitute {
    my ( $text, $secrets, $host ) = @_;
    return $text unless defined $text;
    $text =~ s/__KMH_KEY_(\w+)__/_key($1, $secrets, $host)/ge;
    return $text;
}

sub _key {
    my ( $name, $secrets, $host ) = @_;
    my $hosts = $KEY_HOSTS{$name} // $EXTRA_KEY_HOSTS{$name} or return '';
    return '' unless grep { $_ eq lc( $host // '' ) } @$hosts;
    return $secrets->{$name} // '';
}

sub _authorization {
    my ( $value, $secrets, $host ) = @_;
    # "Basic base64(key:secret)" was encoded in the browser from placeholders
    if ( $value =~ /^Basic\s+(\S+)$/i ) {
        my $plain = decode_base64($1);
        if ( $plain =~ /__KMH_KEY_/ ) {
            return 'Basic ' . encode_base64( substitute( $plain, $secrets, $host ), '' );
        }
    }
    return substitute( $value, $secrets, $host );
}

sub user_agent {
    return LWP::UserAgent->new(
        timeout           => $TIMEOUT,
        max_size          => $MAX_BYTES,
        max_redirect      => 0,    # followed below, each one checked
        protocols_allowed => ['https', 'http'],    # http only reaches listed Koha SRU servers (check_url)
        agent             => 'Koha-MarcHelper-plugin/0.1',
        env_proxy         => 1,
    );
}

=head2 fetch( $request, $secrets [, $ua ] )

$request = { url, method, headers => {}, body, cookies => { name => value } }
Returns { status, url, headers => { 'content-type' => ... }, cookies => [ ... ], body }
or { status => 0, error => '...' }.

=cut

sub fetch {
    my ( $request, $secrets, $ua ) = @_;
    $secrets //= {};
    $ua      //= user_agent();

    my $method = uc( $request->{method} // 'GET' );
    return { status => 0, error => 'Method not allowed' } unless $method =~ /^(?:GET|POST|HEAD)$/;

    my $url = $request->{url} // '';
    my @set_cookies;
    my %cookies = %{ $request->{cookies} // {} };
    my $body    = $request->{body};
    $ua->timeout($AI_TIMEOUT) if is_ai_url($url) && $ua->can('timeout');

    for my $hop ( 0 .. $MAX_REDIRECTS ) {
        if ( my $error = check_url($url) ) {
            return { status => 0, error => $error };
        }
        my $host = lc URI->new($url)->host;
        my $req  = HTTP::Request->new( $method => substitute( $url, $secrets, $host ) );
        my %headers = %{ $request->{headers} // {} };
        for my $name (@FORWARD_HEADERS) {
            my ($given) = grep { lc($_) eq $name } keys %headers;
            next unless defined $given && defined $headers{$given};
            my $value = $name eq 'authorization'
                ? _authorization( $headers{$given}, $secrets, $host )
                : substitute( $headers{$given}, $secrets, $host );
            $value =~ s/[\r\n]//g;
            $req->header( $name => $value );
        }
        if (%cookies) {
            my $cookie = join '; ', map { "$_=$cookies{$_}" } grep { /^[\w.-]+$/ } sort keys %cookies;
            $req->header( Cookie => $cookie ) if $cookie;
        }
        if ( defined $body && $method eq 'POST' ) {
            $req->content( _bytes( substitute( $body, $secrets, $host ) ) );
        }

        my $res = $ua->request($req);
        for my $set ( $res->header('Set-Cookie') ) {
            next unless defined $set;
            push @set_cookies, $set;
            my ($pair) = split /;/, $set;
            my ( $k, $v ) = split /=/, $pair, 2;
            $cookies{ _trim($k) } = _trim($v) if defined $v;
        }
        if ( $res->is_redirect && $res->header('Location') ) {
            $url = URI->new_abs( $res->header('Location'), $url )->as_string;
            if ( $res->code == 303 || ( $res->code =~ /^30[12]$/ && $method eq 'POST' ) ) {
                $method = 'GET';
                undef $body;
            }
            next;
        }
        # LWP marks a reply cut off at max_size, or a connection that broke mid-way
        if ( $res->header('Client-Aborted') || $res->header('X-Died') ) {
            return { status => 0, error => 'The source sent more than 5 MB, or the connection broke' };
        }
        if ( $res->code == 500 && ( $res->header('Client-Warning') // '' ) eq 'Internal response' ) {
            my $why = $res->message // 'connection failed';
            return { status => 0, error => "Could not reach the source ($why)" };
        }
        return {
            status  => $res->code + 0,
            url     => $url,
            headers => { 'content-type' => scalar $res->header('Content-Type') // '' },
            cookies => \@set_cookies,
            body    => $res->decoded_content( default_charset => 'UTF-8' ) // '',
        };
    }
    return { status => 0, error => 'Too many redirects' };
}

=head2 fetch_many( \@requests, $secrets [, $deadline ] )

Fetches several requests at the same time inside this one server process (Mojo's
non-blocking user agent), with the same checks as fetch(). For Koha servers with few
Plack workers: one call does the work of many, so requests do not queue. Returns a list
of results in the same order; a request not answered within $deadline seconds gets
{ status => 0, error => '... timed out ...' }.

=cut

our $MAX_BATCH = 30;

sub fetch_many {
    my ( $requests, $secrets, $deadline ) = @_;
    require Mojo::UserAgent;
    require Mojo::Promise;
    require Mojo::IOLoop;
    $secrets  //= {};
    $deadline //= 9;
    my @list = @{ $requests // [] };
    splice @list, $MAX_BATCH if @list > $MAX_BATCH;

    my $ua = Mojo::UserAgent->new(
        max_redirects      => 0,    # followed below, each one checked
        max_response_size  => $MAX_BYTES,
        connect_timeout    => $deadline,
        inactivity_timeout => $deadline,
        request_timeout    => $deadline,
    );
    $ua->transactor->name('Koha-MarcHelper-plugin');
    $ua->proxy->detect;

    my @results = map { { status => 0, error => "The source did not answer within $deadline seconds (timed out)" } } @list;
    my @pending = map {
        my $i = $_;
        _fetch_p( $ua, $list[$i], $secrets )->then(
            sub { $results[$i] = shift },
            sub { $results[$i] = { status => 0, error => 'Could not reach the source (' . ( shift // 'error' ) . ')' } }
        );
    } 0 .. $#list;
    if (@pending) {
        my $timer = Mojo::Promise->new;
        my $id    = Mojo::IOLoop->timer( $deadline + 1 => sub { $timer->resolve } );
        Mojo::Promise->race( Mojo::Promise->all(@pending), $timer )->wait;
        Mojo::IOLoop->remove($id);
    }
    return \@results;
}

sub _fetch_p {
    my ( $ua, $request, $secrets ) = @_;
    my $method = uc( $request->{method} // 'GET' );
    return Mojo::Promise->resolve( { status => 0, error => 'Method not allowed' } )
        unless $method =~ /^(?:GET|POST|HEAD)$/;
    my %cookies = %{ $request->{cookies} // {} };
    my @set_cookies;
    my $step;
    $step = sub {
        my ( $url, $method, $body, $hop ) = @_;
        return Mojo::Promise->resolve( { status => 0, error => 'Too many redirects' } ) if $hop > $MAX_REDIRECTS;
        if ( my $error = check_url($url) ) {
            return Mojo::Promise->resolve( { status => 0, error => $error } );
        }
        my $host = lc URI->new($url)->host;
        my %headers;
        my %given = %{ $request->{headers} // {} };
        for my $name (@FORWARD_HEADERS) {
            my ($key) = grep { lc($_) eq $name } keys %given;
            next unless defined $key && defined $given{$key};
            my $value = $name eq 'authorization' ? _authorization( $given{$key}, $secrets, $host ) : substitute( $given{$key}, $secrets, $host );
            $value =~ s/[\r\n]//g;
            $headers{$name} = $value;
        }
        my $cookie = join '; ', map { "$_=$cookies{$_}" } grep { /^[\w.-]+$/ } sort keys %cookies;
        $headers{Cookie} = $cookie if $cookie;
        my @content = ( defined $body && $method eq 'POST' ) ? ( _bytes( substitute( $body, $secrets, $host ) ) ) : ();
        my $tx = $ua->build_tx( $method => substitute( $url, $secrets, $host ) => \%headers => @content );
        return $ua->start_p($tx)->then( sub {
            my $res = shift->res;
            if ( !$res->code ) {
                my $why = ( $res->error // {} )->{message} // 'connection failed';
                return { status => 0, error => "Could not reach the source ($why)" };
            }
            return { status => 0, error => 'The source sent more than 5 MB' } if $res->is_limit_exceeded;
            for my $c ( @{ $res->cookies } ) {
                push @set_cookies, $c->name . '=' . $c->value;
                $cookies{ $c->name } = $c->value;
            }
            if ( $res->is_redirect && ( my $location = $res->headers->location ) ) {
                my $next = URI->new_abs( $location, $url )->as_string;
                my ( $m, $b ) = ( $method, $body );
                if ( $res->code == 303 || ( $res->code =~ /^30[12]$/ && $method eq 'POST' ) ) {
                    ( $m, $b ) = ( 'GET', undef );
                }
                return $step->( $next, $m, $b, $hop + 1 );
            }
            return {
                status  => $res->code + 0,
                url     => $url,
                headers => { 'content-type' => $res->headers->content_type // '' },
                cookies => [@set_cookies],
                body    => $res->text // '',
            };
        } );
    };
    return $step->( $request->{url} // '', $method, $request->{body}, 0 )->finally( sub { undef $step } );
}

sub _trim { my ($s) = @_; $s //= ''; $s =~ s/^\s+|\s+$//g; return $s }

sub _bytes {
    my ($text) = @_;
    utf8::encode($text) if utf8::is_utf8($text);
    return $text;
}

1;
