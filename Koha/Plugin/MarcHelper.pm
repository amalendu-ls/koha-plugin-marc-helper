package Koha::Plugin::MarcHelper;

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

use Modern::Perl;
use base qw(Koha::Plugins::Base);

use C4::Context;
use Mojo::JSON qw(decode_json encode_json);
use URI;

our $VERSION         = '1.0.1';
our $MINIMUM_VERSION = '22.11.00.000';

our $metadata = {
    name            => 'Koha MARC Helper',
    author          => 'Amalendu Das',
    date_authored   => '2026-11-15',
    date_updated    => '2026-11-18',
    minimum_version => $MINIMUM_VERSION,
    maximum_version => undef,
    version         => $VERSION,
    description     => 'Copy cataloguing on the Add MARC record page: search library catalogues and '
        . 'open sources by ISBN, ISSN or title, build a MARC 21 record (AACR2 and your local rules, '
        . 'nothing guessed), check it and fill the form. Batch cataloguing under Tools: a list of '
        . 'ISBNs and ISSNs, each record reviewed, then staged for import.',
    namespace       => 'marchelper',
};

# Settings, with defaults equal to the browser extension's local policy
our %DEFAULTS = (
    institutionName       => '',
    itemType              => 'BK',
    serialItemType        => '',      # 942 $c for serials (found by ISSN); '' = itemType
    ruleEndingPunctuation => 'remove',
    ruleStatement         => 'by',
    ruleOfThree           => 'apply',
    ruleItemNumber        => 'generate',
    rulePublicationField  => '260',
    localFields           => '',
    kohaOpacs             => '',      # other libraries' Koha OPACs, one per line: "Name | https://…"
    sourcesOff            => '[]',    # JSON list of source names not searched
    sourceOrder           => '[]',    # JSON list of source names, first wins when merging
    llmProvider           => '',      # AI Helper: '' (off), openai, gemini, deepseek, perplexity, ollama, copilot
    ollamaBaseUrl         => '',      # Ollama server, e.g. http://localhost:11434
    ollamaModel           => 'llama3',
    copilotEndpoint       => '',      # Azure OpenAI chat completions address
);
our @LISTS = qw(sourcesOff sourceOrder);
our @CHOICES = (
    [ ruleEndingPunctuation => qw(remove keep) ],
    [ ruleStatement         => qw(by transcribed) ],
    [ ruleOfThree           => qw(apply off) ],
    [ ruleItemNumber        => qw(generate off) ],
    [ rulePublicationField  => qw(260 264) ],
    [ llmProvider           => '', qw(openai gemini deepseek perplexity ollama copilot) ],
);
# The one address each AI provider is reached at (as background.js calls it)
our %AI_URLS = (
    openai     => 'https://api.openai.com/v1/chat/completions',
    gemini     => 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    deepseek   => 'https://api.deepseek.com/v1/chat/completions',
    perplexity => 'https://api.perplexity.ai/chat/completions',
);
# Keys never leave the server: the panel gets a placeholder the relay replaces
our @SECRETS = qw(googleApiKey worldcatApiKey worldcatApiSecret isbnDbApiKey
    openaiApiKey geminiApiKey deepseekApiKey perplexityApiKey copilotApiKey);

sub new {
    my ( $class, $args ) = @_;
    $args->{metadata} = $metadata;
    $args->{metadata}->{class} = $class;
    return $class->SUPER::new($args);
}

sub install {
    my ($self) = @_;
    $self->store_data( { map { $_ => $DEFAULTS{$_} } keys %DEFAULTS } );
    return 1;
}

sub upgrade   { return 1 }
sub uninstall { return 1 }

# --- Settings -------------------------------------------------------------------------

sub settings {
    my ($self) = @_;
    my %s = map { $_ => $self->retrieve_data($_) // $DEFAULTS{$_} } keys %DEFAULTS;
    return \%s;
}

sub secrets {
    my ($self) = @_;
    return { map { $_ => $self->_decrypt( $self->retrieve_data($_) ) // '' } @SECRETS };
}

# What the panel receives: settings, plus a placeholder for each key that is set
sub client_settings {
    my ($self) = @_;
    my $settings = $self->settings;
    my $secrets  = $self->secrets;
    $settings->{$_} = $secrets->{$_} ne '' ? "__KMH_KEY_${_}__" : '' for @SECRETS;
    $settings->{$_} = _list( $settings->{$_} ) for @LISTS;
    # Few Plack workers: the panel groups its source requests (relay/batch) so they do not queue
    $settings->{relayWorkers} = ( eval { C4::Context->config('plack_workers') } // 0 ) + 0;
    $settings->{opacUrl}     = '';    # "already in your library" uses Koha itself (step 2)
    my ($ai_url) = @{ $self->ai_access->{urls} };
    $settings->{llmProvider} = '' unless $ai_url;    # chosen but not usable (no address): off
    $settings->{aiUrl}       = $ai_url // '';
    # Batch cataloguing: Koha's matching rules (Administration › Record matching rules)
    $settings->{matchers} = [ map { { id => $_->{matcher_id} + 0, code => $_->{code}, description => $_->{description} } }
            eval { require C4::Matcher; C4::Matcher::GetMatcherList() } ];
    return $settings;
}

# A page of this plugin, with Koha's login cookie. Koha::Plugins::Base::get_template drops
# the cookie Koha makes when staff log in on the page itself (after their session ran out),
# so the browser kept its old, logged-out cookie and the page asked for the login again and
# again; here the cookie is kept and sent with the page (_show).
sub _page {
    my ( $self, $file ) = @_;
    require C4::Auth;
    require C4::Languages;
    my ( $template, undef, $cookie ) = C4::Auth::get_template_and_user(
        {
            template_name   => $self->mbf_path($file),
            query           => $self->{cgi},
            type            => 'intranet',
            authnotrequired => 1,
        }
    );
    $template->param(
        CLASS       => $self->{class},
        METHOD      => scalar $self->{cgi}->param('method'),
        PLUGIN_PATH => $self->get_plugin_http_path(),
        PLUGIN_DIR  => $self->bundle_path(),
        LANG        => C4::Languages::getlanguage( $self->{cgi} ),
    );
    return ( $template, $cookie );
}

sub _show {
    my ( $self, $template, $cookie ) = @_;
    require C4::Output;
    C4::Output::output_with_http_headers( $self->{cgi}, $cookie, $template->output(), 'html' );
}

# Tools › Plugins › Koha MARC Helper: batch cataloguing
sub tool {
    my ($self) = @_;
    my ( $template, $cookie ) = $self->_page('tool.tt');
    my $userid   = eval { C4::Context->userenv->{id} } // '';
    require C4::Auth;
    $template->param(
        plugin_version => $VERSION,
        can_stage      => ( C4::Auth::haspermission( $userid, { tools => 'stage_marc_import' } ) ? 1 : 0 ),
        can_catalogue  => ( C4::Auth::haspermission( $userid, { editcatalogue => 'edit_catalogue' } ) ? 1 : 0 ),
    );
    $self->_show( $template, $cookie );
}

# The AI provider the library chose: its one address, and for Azure OpenAI the host its key
# may go to. Ollama may be http (often on the Koha server itself); Azure must be https.
sub ai_access {
    my ($self) = @_;
    my $provider = $self->retrieve_data('llmProvider') // '';
    my ( $url, %key_hosts );
    if ( $AI_URLS{$provider} ) {
        $url = $AI_URLS{$provider};
    } elsif ( $provider eq 'ollama' ) {
        my $base = $self->retrieve_data('ollamaBaseUrl') // '';
        $base =~ s{/+$}{};
        my $uri = eval { URI->new("$base/api/generate") };
        $url = "$uri" if $uri && $uri->can('host') && $uri->host && $uri->scheme =~ /^https?$/ && !defined $uri->userinfo;
    } elsif ( $provider eq 'copilot' ) {
        my $uri = eval { URI->new( $self->retrieve_data('copilotEndpoint') // '' ) };
        if ( $uri && $uri->can('host') && $uri->host && $uri->scheme eq 'https' && !defined $uri->userinfo ) {
            $url = "$uri";
            $key_hosts{copilotApiKey} = [ lc $uri->host ];
        }
    }
    return { urls => [ $url ? ($url) : () ], key_hosts => \%key_hosts };
}

# What the library listed under Koha OPACs: the OPAC hosts (https, port 443) and the exact
# SRU server origins ("http://host:9999"); the relay may reach these too, and nothing else
sub opac_access {
    my ($self) = @_;
    my ( @hosts, @origins );
    for my $line ( split /\r?\n/, $self->retrieve_data('kohaOpacs') // '' ) {
        for my $part ( split /\|/, $line ) {
            $part =~ s/^\s+|\s+$//g;
            next if $part =~ /^api$/i;                      # the OPAC's own host, listed anyway
            my $api = $part =~ s/^api\s*=\s*//i;
            my $sru = $part =~ s/^sru\s*=\s*//i;
            next unless $part =~ m{^[a-z]+://}i || $part =~ m{^[\w-]+(\.[\w-]+)+(:\d+)?(/\S*)?$};
            $part = ( $sru ? 'http' : 'https' ) . "://$part" unless $part =~ m{^[a-z]+://}i;
            my $uri = eval { URI->new($part) };
            next unless $uri && $uri->can('host') && $uri->host;
            my $scheme = lc( $uri->scheme // '' );
            if ($sru) {
                push @origins, sprintf( '%s://%s:%d', $scheme, lc $uri->host, $uri->port ) if $scheme =~ /^https?$/;
            } elsif ( $scheme eq 'https' ) {
                push @hosts, lc $uri->host;
            } elsif ( $scheme eq 'http' && $uri->host =~ /^(localhost|127\.0\.0\.1)$/ ) {
                # A Koha on this same server (testing): exactly its origin
                push @origins, sprintf( 'http://%s:%d', lc $uri->host, $uri->port );
            }
        }
    }
    my ( %h, %o );
    return ( [ grep { !$h{$_}++ } @hosts ], [ grep { !$o{$_}++ } @origins ] );
}

sub opac_hosts { my ($self) = @_; return @{ ( $self->opac_access )[0] } }

# A stored JSON list of source names, checked: strings only, short, at most 40
sub _list {
    my ($text) = @_;
    my $list = eval { decode_json( $text // '[]' ) };
    return [] unless ref $list eq 'ARRAY';
    return [ grep { defined($_) && !ref($_) && length($_) && length($_) <= 60 } @$list[ 0 .. ( $#$list < 39 ? $#$list : 39 ) ] ];
}

# Koha::Encryption (encryption_key in koha-conf.xml) when the Koha has it
sub _encrypt {
    my ( $self, $value ) = @_;
    return $value if !defined $value || $value eq '';
    my $hex = eval { require Koha::Encryption; Koha::Encryption->new->encrypt_hex($value) };
    return $hex ? "enc:$hex" : $value;
}

sub _decrypt {
    my ( $self, $value ) = @_;
    return $value unless defined $value && $value =~ /^enc:(.+)$/;
    my $plain = eval { require Koha::Encryption; Koha::Encryption->new->decrypt_hex($1) };
    return $plain // '';
}

sub configure {
    my ( $self, $args ) = @_;
    my $cgi = $self->{cgi};
    my $op  = $cgi->param('op') // '';

    if ( $op eq 'cud-save' || $cgi->param('save') ) {
        my %data;
        for my $key ( keys %DEFAULTS ) {
            my $value = $cgi->param($key) // '';
            $value =~ s/\r\n/\n/g;
            $value =~ s/^\s+|\s+$//g unless $key eq 'localFields' || $key eq 'kohaOpacs';
            $data{$key} = $value;
        }
        for my $choice (@CHOICES) {
            my ( $key, @allowed ) = @$choice;
            $data{$key} = $DEFAULTS{$key} unless grep { $_ eq $data{$key} } @allowed;
        }
        $data{itemType} ||= 'BK';
        $data{$_} = encode_json( _list( $data{$_} ) ) for @LISTS;
        for my $key (@SECRETS) {
            # An empty box keeps the saved key; "clear" removes it
            if ( $cgi->param("${key}_clear") ) {
                $data{$key} = '';
            }
            elsif ( defined( my $value = $cgi->param($key) ) ) {
                $value =~ s/^\s+|\s+$//g;
                $data{$key} = $self->_encrypt($value) if $value ne '';
            }
        }
        $self->store_data( \%data );
    }

    my ( $template, $cookie ) = $self->_page('configure.tt');
    my $secrets  = $self->secrets;
    my $tab      = $cgi->param('tab') // '';
    $template->param(
        %{ $self->settings },
        map( { ( "${_}_set" => ( $secrets->{$_} ne '' ? 1 : 0 ) ) } @SECRETS ),
        saved         => ( $op eq 'cud-save' || $cgi->param('save') ) ? 1 : 0,
        tab           => ( $tab =~ /^(library|rules|sources|keys|ai|about)$/ ? $tab : 'library' ),
        plugin_version => $VERSION,
        koha_version  => C4::Context->preference('Version') // '',
        item_types    => $self->_item_types,
        plack_workers => eval { C4::Context->config('plack_workers') } // '',
        encryption_ok => ( eval { require Koha::Encryption; Koha::Encryption->new; 1 } ? 1 : 0 ),
    );
    $self->_show( $template, $cookie );
}

# Item types of this Koha, for the 942 $c choice (empty list: a text box is shown)
sub _item_types {
    my $list = eval {
        require Koha::ItemTypes;
        [ map { { code => $_->itemtype, name => $_->description } }
              Koha::ItemTypes->search( {}, { order_by => 'description' } )->as_list ];
    };
    return $list || [];
}

# --- REST API and static files ----------------------------------------------------------

sub api_namespace { return 'marchelper' }

sub api_routes {
    my ($self) = @_;
    return decode_json( $self->mbf_read('openapi.json') );
}

sub static_routes {
    my ($self) = @_;
    return decode_json( $self->mbf_read('staticapi.json') );
}

# --- The panel on the Add MARC record page ---------------------------------------------

sub intranet_js {
    my ($self) = @_;
    my $version = $VERSION;
    return <<"JS";
<script>
/* Koha MARC Helper $version: loads the panel on the Add MARC record page only */
(function () {
  if (!/\\/cataloguing\\/addbiblio\\.pl\$/.test(location.pathname)) return;
  var base = '/api/v1/contrib/marchelper/static/static/';
  var css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = base + 'panel.css?v=$version';
  document.head.appendChild(css);
  var files = ['marc-parser.js', 'marcxml.js', 'marc-tools.js', 'marc-labels.js', 'engine.js', 'filler.js', 'panel.js'];
  (function next(i) {
    if (i >= files.length) { if (window.MarcHelper) window.MarcHelper.init(base, '$version'); return; }
    var s = document.createElement('script');
    s.src = base + files[i] + '?v=$version';
    s.onload = function () { next(i + 1); };
    s.onerror = function () { console.error('Koha MARC Helper: could not load ' + files[i]); };
    document.body.appendChild(s);
  })(0);
})();
</script>
JS
}

1;
