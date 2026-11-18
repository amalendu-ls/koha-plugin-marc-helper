package Koha::Plugin::MarcHelper::Controller;

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

# REST endpoints for the panel (staff with cataloguing permission only, see openapi.json):
#   GET  /api/v1/contrib/marchelper/settings   the library's settings, keys as placeholders
#   POST /api/v1/contrib/marchelper/relay      fetch from an approved book source
#   POST /api/v1/contrib/marchelper/relay/batch several at once, in parallel
#   POST /api/v1/contrib/marchelper/authorities  headings looked up in the library's authority file
#   POST /api/v1/contrib/marchelper/stage        batch records into Koha's staging area (Tools)

use Modern::Perl;
use Mojo::Base 'Mojolicious::Controller';
use Try::Tiny;

use Koha::Plugin::MarcHelper;
use Koha::Plugin::MarcHelper::Relay;
use Koha::Plugin::MarcHelper::Authorities;
use Koha::Plugin::MarcHelper::Stage;

sub settings {
    my $c = shift->openapi->valid_input or return;
    return try {
        my $plugin = Koha::Plugin::MarcHelper->new;
        $c->render( status => 200, openapi => $plugin->client_settings );
    }
    catch {
        $c->render( status => 500, openapi => { error => "Could not read the settings: $_" } );
    };
}

sub relay {
    my $c = shift->openapi->valid_input or return;
    my $request = $c->req->json // {};
    return try {
        my $plugin = Koha::Plugin::MarcHelper->new;
        my ( $hosts, $origins ) = $plugin->opac_access;
        my $ai = $plugin->ai_access;
        local @Koha::Plugin::MarcHelper::Relay::EXTRA_HOSTS     = @$hosts;
        local @Koha::Plugin::MarcHelper::Relay::EXTRA_ORIGINS   = @$origins;
        local @Koha::Plugin::MarcHelper::Relay::AI_URLS         = @{ $ai->{urls} };
        local %Koha::Plugin::MarcHelper::Relay::EXTRA_KEY_HOSTS = %{ $ai->{key_hosts} };
        my $result = Koha::Plugin::MarcHelper::Relay::fetch( $request, $plugin->secrets );
        $c->render( status => 200, openapi => $result );
    }
    catch {
        $c->render( status => 500, openapi => { error => "Relay failed: $_" } );
    };
}

# Several requests in one call, fetched at the same time (see Relay::fetch_many)
sub relay_batch {
    my $c = shift->openapi->valid_input or return;
    my $body = $c->req->json // {};
    return try {
        my $plugin  = Koha::Plugin::MarcHelper->new;
        my ( $hosts, $origins ) = $plugin->opac_access;
        my $ai = $plugin->ai_access;
        local @Koha::Plugin::MarcHelper::Relay::EXTRA_HOSTS     = @$hosts;
        local @Koha::Plugin::MarcHelper::Relay::EXTRA_ORIGINS   = @$origins;
        local @Koha::Plugin::MarcHelper::Relay::AI_URLS         = @{ $ai->{urls} };
        local %Koha::Plugin::MarcHelper::Relay::EXTRA_KEY_HOSTS = %{ $ai->{key_hosts} };
        my $results = Koha::Plugin::MarcHelper::Relay::fetch_many( $body->{requests} // [], $plugin->secrets );
        $c->render( status => 200, openapi => { results => $results } );
    }
    catch {
        $c->render( status => 500, openapi => { error => "Relay failed: $_" } );
    };
}

# Batch cataloguing: the reviewed records staged for import (staging permission, see openapi.json)
sub stage {
    my $c = shift->openapi->valid_input or return;
    my $body = $c->req->json // {};
    return try {
        my $result = Koha::Plugin::MarcHelper::Stage::stage($body);
        $c->render( status => ( $result->{error} ? 400 : 200 ), openapi => $result );
    }
    catch {
        $c->render( status => 500, openapi => { error => "Staging failed: $_" } );
    };
}

# Each heading of the record looked up in the library's own authority file (read only)
sub authorities {
    my $c = shift->openapi->valid_input or return;
    my $body = $c->req->json // {};
    return try {
        my $results = Koha::Plugin::MarcHelper::Authorities::check_all( $body->{headings} // [] );
        $c->render( status => 200, openapi => { results => $results } );
    }
    catch {
        $c->render( status => 500, openapi => { error => "Authority search failed: $_" } );
    };
}

1;
