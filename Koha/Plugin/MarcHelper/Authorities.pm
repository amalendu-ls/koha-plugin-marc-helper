package Koha::Plugin::MarcHelper::Authorities;

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

# Check headings against the library's own authority file. Koha's own heading code
# (C4::Heading, used by Koha's authority linker) finds the matches, so the panel sees what
# "Link authorities automatically" would; nothing is changed here, the cataloguer chooses.

use Modern::Perl;
use MARC::Field;
use C4::Heading;
use Koha::Authorities;

our @TAGS = qw(100 110 111 130 600 610 611 630 648 650 651 655 700 710 711 730);
our $MAX_HEADINGS = 40;
our $MAX_MATCHES  = 5;

# heading: {tag, ind1, ind2, subfields: [[code, value], ...]}
# returns: {tag, display, type, via?, matches: [{authid, heading, subfields, usage, same, type}], error?}
# via 'see': nothing under the authorised form, these were found under a "see from" form
sub check {
    my ($heading) = @_;
    my $tag = $heading->{tag} // '';
    my %out = ( tag => $tag, matches => [] );
    return { %out, error => 'Not a heading field' } unless grep { $_ eq $tag } @TAGS;
    my @subfields = map { ( $_->[0], $_->[1] ) }
        grep { ref $_ eq 'ARRAY' && defined $_->[0] && $_->[0] =~ /^[a-z0-9]$/ && defined $_->[1] && $_->[1] ne '' }
        @{ $heading->{subfields} // [] };
    return { %out, error => 'Empty heading' } unless @subfields;
    my $field = eval {
        MARC::Field->new( $tag, ( $heading->{ind1} // ' ' ), ( $heading->{ind2} // ' ' ), @subfields );
    };
    return { %out, error => 'Not a valid MARC field' } unless $field;

    my $h = eval { C4::Heading->new_from_field($field) };
    return { %out, error => 'Koha does not treat this field as a heading' } unless $h;
    $out{display} = $h->display_form;
    $out{type}    = $h->auth_type;

    # The authorised heading first (what Koha's linker matches); when there is none, the
    # "see from" forms too (4XX), so a variant leads to the library's authorised form
    my $found = eval { $h->authorities(1) } || [];
    unless (@$found) {
        my ($see) = eval { C4::Heading::_search( $h, 'match', 1 ) };
        if ( $see && @$see ) { $found = $see; $out{via} = 'see' }
    }
    my $want  = _normal( $out{display} );
    for my $hit ( grep { defined } @$found[ 0 .. ( $#$found < $MAX_MATCHES - 1 ? $#$found : $MAX_MATCHES - 1 ) ] ) {
        my $authid = ref $hit ? $hit->{authid} : $hit;
        next unless $authid;
        my $auth   = Koha::Authorities->find($authid) or next;
        my $record = eval { $auth->record } or next;
        my ($main) = grep { $_->tag =~ /^1\d\d$/ } $record->fields;
        next unless $main;
        my @subs = grep { $_->[0] =~ /^[a-z]$/ } $main->subfields;
        # As LC writes it: "Tagore, Rabindranath, 1861-1941", "United Nations. General Assembly"
        my $main_text = '';
        for my $sf ( grep { $_->[0] !~ /^[vxyz]$/ } @subs ) {
            my ( $code, $value ) = @$sf;
            $value =~ s/[\s,:;\/]+$//;
            my $sep = !length $main_text                         ? ''
                : ( $main->tag eq '100' && $code =~ /^[cd]$/ ) ? ', '
                : ( $main->tag eq '110' && $code eq 'b' )      ? '. '
                :                                                ' ';
            $main_text =~ s/\.$// if $sep =~ /^[,.]/ && $main_text !~ /\b\p{Lu}\.$/;
            $main_text .= $sep . $value;
        }
        my $display = join '--', grep { length } ( $main_text, map { $_->[1] } grep { $_->[0] =~ /^[vxyz]$/ } @subs );
        push @{ $out{matches} }, {
            authid    => $authid + 0,
            heading   => $display,
            subfields => [ map { [ $_->[0], $_->[1] ] } @subs ],
            usage     => ( eval { Koha::Authorities->get_usage_count( { authid => $authid } ) } // 0 ) + 0,
            same      => ( _normal($display) eq $want ) ? 1 : 0,
            type      => $auth->authtypecode,
        };
    }
    return \%out;
}

sub check_all {
    my ($headings) = @_;
    my @list = @{ $headings // [] };
    splice @list, $MAX_HEADINGS if @list > $MAX_HEADINGS;
    return [ map { check($_) } @list ];
}

sub _normal {
    my ($text) = @_;
    $text //= '';
    $text = lc $text;
    $text =~ s/[^\p{L}\p{N}]+/ /g;
    $text =~ s/^\s+|\s+$//g;
    return $text;
}

1;
